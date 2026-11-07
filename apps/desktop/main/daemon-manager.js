'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const logger = require('./logger');

const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = 1500;
const READY_TIMEOUT_MS = 15000;

/**
 * Resolves the platform-appropriate private endpoint for the gateway.
 * Unix domain sockets on POSIX, named pipes on Windows.
 */
function defaultSocketPath() {
  if (process.platform === 'win32') return '\\\\.\\pipe\\alaye-os-hermes';
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `alaye-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  return path.join(runtimeDir, 'alaye-hermes.sock');
}

/**
 * Supervises the embedded Hermes gateway daemon process.
 *
 * In development the daemon runs from source. In a packaged build it runs
 * from the `resources/core` directory injected via electron-builder
 * `extraResources`.
 */
class DaemonManager {
  constructor({ appRoot, isDev }) {
    this.appRoot = appRoot;
    this.isDev = isDev;
    this.socketPath = process.env.ALAYE_SOCKET || defaultSocketPath();
    this.child = null;
    this.restarts = 0;
    this.stopping = false;
    this.ready = false;
  }

  /**
   * Path to the editable provider config, passed to the daemon so it can
   * inject OPENAI_API_KEY / OPENAI_BASE_URL / DEFAULT_MODEL into Hermes.
   */
  resolveProviderConfigPath() {
    const candidates = [
      process.env.ALAYE_PROVIDER_CONFIG,
      this.isDev ? path.join(this.appRoot, 'config', 'default-provider.json') : null,
      process.resourcesPath
        ? path.join(process.resourcesPath, 'config', 'default-provider.json')
        : null,
    ].filter(Boolean);
    for (const file of candidates) {
      if (fs.existsSync(file)) return file;
    }
    return path.join(this.appRoot, 'config', 'default-provider.json');
  }

  /**
   * Bundled engine directory (resources/engine) when the app was packaged with
   * one. Returned so the daemon can point Hermes at it via ALAYE_ENGINE_DIR.
   */
  resolveEngineDir() {
    if (!process.resourcesPath) return null;
    const dir = path.join(process.resourcesPath, 'engine');
    if (
      fs.existsSync(path.join(dir, 'hermes_launcher.py')) ||
      fs.existsSync(path.join(dir, 'hermes.cmd')) ||
      fs.existsSync(path.join(dir, 'hermes.exe'))
    ) {
      return dir;
    }
    return null;
  }

  /** Path to the daemon entrypoint for the current run mode. */
  resolveEntrypoint() {
    const coreDir = this.isDev
      ? path.resolve(this.appRoot, '..', '..', 'core')
      : path.join(process.resourcesPath, 'core');
    return path.join(coreDir, 'daemon', 'index.js');
  }

  async start() {
    this.stopping = false;
    const entry = this.resolveEntrypoint();
    if (!fs.existsSync(entry)) {
      throw new Error(`daemon entrypoint not found at ${entry}`);
    }

    const engineDir = this.resolveEngineDir();

    this.child = spawn(process.execPath, [entry], {
      cwd: path.dirname(path.dirname(entry)),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ALAYE_SOCKET: this.socketPath,
        ALAYE_APP_VERSION: require('../package.json').version,
        ALAYE_LOG_LEVEL: this.isDev ? 'debug' : 'info',
        ALAYE_APP_ROOT: this.appRoot,
        ALAYE_PROVIDER_CONFIG: this.resolveProviderConfigPath(),
        ALAYE_ENV_FILE: process.env.ALAYE_ENV_FILE || path.join(os.homedir(), '.alaye-os', 'alaye.env'),
        ...(engineDir && { ALAYE_ENGINE_DIR: engineDir }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.on('data', (d) => logger.debug(`[daemon] ${d.toString().trim()}`));
    this.child.stderr.on('data', (d) => logger.warn(`[daemon] ${d.toString().trim()}`));
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
    this.child.on('error', (err) => logger.error('[daemon] spawn error', err));

    await this.waitForReady();
    this.restarts = 0;
    this.ready = true;
  }

  /** Polls the socket until the daemon accepts a connection or we time out. */
  waitForReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.connect(this.socketPath);
        socket
          .once('connect', () => {
            socket.destroy();
            resolve();
          })
          .once('error', () => {
            socket.destroy();
            if (Date.now() > deadline) {
              reject(new Error('gateway did not become ready in time'));
            } else {
              setTimeout(attempt, 250);
            }
          });
      };
      attempt();
    });
  }

  onExit(code, signal) {
    this.ready = false;
    if (this.stopping) return;
    logger.warn(`[daemon] exited code=${code} signal=${signal}`);

    if (this.restarts >= MAX_RESTARTS) {
      logger.error('[daemon] restart budget exhausted; leaving gateway offline');
      return;
    }
    this.restarts += 1;
    const delay = RESTART_BACKOFF_MS * this.restarts;
    logger.info(`[daemon] restart ${this.restarts}/${MAX_RESTARTS} in ${delay}ms`);
    setTimeout(() => {
      this.start().catch((err) => logger.error('[daemon] restart failed', err));
    }, delay);
  }

  async stop() {
    this.stopping = true;
    if (!this.child || this.child.killed) return;
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        this.child?.kill('SIGKILL');
        resolve();
      }, 5000);
      this.child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}

module.exports = { DaemonManager, defaultSocketPath };
