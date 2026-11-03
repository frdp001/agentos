'use strict';

const { ipcMain, app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('electron-store');
const logger = require('./logger');
const { RpcClient } = require('./rpc-client');
const { defaultSocketPath } = require('./daemon-manager');
const { IPC, PUSH, AGENT, SECRET_KEYS } = require('@alaye/shared');
const store = new Store({ name: 'alaye-settings' });

/** Resolve a fresh RPC client bound to the live gateway socket. */
function getClient() {
  return new RpcClient(process.env.ALAYE_SOCKET || defaultSocketPath());
}

/**
 * Resolve the editable provider config bundled with the app
 * (resources/config/default-provider.json) or a user copy.
 */
function resolveProviderConfig() {
  const candidates = [
    process.env.ALAYE_PROVIDER_CONFIG,
    path.join(os.homedir(), '.alaye-os', 'data', 'default-provider.json'),
    path.join(app.getAppPath(), 'config', 'default-provider.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'config', 'default-provider.json') : null,
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ...cfg, _source: file };
      }
    } catch (err) {
      logger.warn(`invalid provider config: ${file}`, err.message);
    }
  }
  return {};
}

/** Lazily create a keytar handle; absent native module -> no secret vault. */
function keytar() {
  try {
    return require('keytar');
  } catch {
    logger.warn('keytar unavailable - secrets stored in secured config fallback');
    return null;
  }
}

function registerIpcHandlers() {
  // --- Settings & secrets -------------------------------------------------
  ipcMain.handle(IPC.SETTINGS_GET, (_e, key) => store.get(key));
  ipcMain.handle(IPC.SETTINGS_SET, (_e, key, value) => {
    store.set(key, value);
    return true;
  });

  ipcMain.handle(IPC.SECRET_SET, async (_e, key, value) => {
    if (!SECRET_KEYS.includes(key)) throw new Error(`non-allowlisted secret: ${key}`);
    const kt = keytar();
    if (kt) return kt.setPassword('alaye-os', key, value);
    store.set(`secrets.${key}`, value);
    return true;
  });
  ipcMain.handle(IPC.SECRET_HAS, async (_e, key) => {
    if (!SECRET_KEYS.includes(key)) throw new Error(`non-allowlisted secret: ${key}`);
    const kt = keytar();
    if (kt) return Boolean(await kt.getPassword('alaye-os', key));
    return Boolean(store.get(`secrets.${key}`));
  });

  /** Report which allow-listed credentials are present (never their values). */
  ipcMain.handle(IPC.SECRET_LIST, async () => {
    const kt = keytar();
    const present = {};
    for (const key of SECRET_KEYS) {
      present[key] = kt
        ? Boolean(await kt.getPassword('alaye-os', key))
        : Boolean(store.get(`secrets.${key}`));
    }
    return { backend: kt ? 'keychain' : 'config-fallback', present };
  });

  ipcMain.handle(IPC.SECRET_DELETE, async (_e, key) => {
    if (!SECRET_KEYS.includes(key)) throw new Error(`non-allowlisted secret: ${key}`);
    const kt = keytar();
    if (kt) {
      await kt.deletePassword('alaye-os', key);
    } else {
      store.delete(`secrets.${key}`);
    }
    return true;
  });

  /**
   * Default provider settings for Settings-view hydration. The raw API key is
   * never returned; only whether a usable key is present.
   */
  ipcMain.handle(IPC.PROVIDER_DEFAULTS, () => {
    const cfg = resolveProviderConfig();
    const rawKey = String(cfg.openai_api_key || '');
    const hasApiKey = Boolean(rawKey) && !rawKey.startsWith('YOUR_');
    return {
      provider: cfg.provider || 'openai',
      openai_base_url: cfg.openai_base_url || '',
      default_model: cfg.default_model || '',
      hasApiKey,
      source: cfg._source || null,
    };
  });

  // --- Daemon RPC passthrough --------------------------------------------
  ipcMain.handle(IPC.RPC, async (_e, method, params) => {
    return getClient().call(method, params);
  });

  ipcMain.handle(IPC.DAEMON_HEALTH, async () => {
    try {
      await getClient().call('daemon.ping');
      return { online: true, version: app.getVersion() };
    } catch (err) {
      return { online: false, error: err.message, version: app.getVersion() };
    }
  });

  // --- Chat console: streamed agent RPC ----------------------------------
  /**
   * Runs the daemon's `agent.stream` method and forwards each token as a
   * push event to the calling renderer. Resolves with the aggregated result
   * once the engine finishes.
   */
  ipcMain.handle(IPC.AGENT_CHAT, async (event, message, sessionId) => {
    const sender = event.sender;
    try {
      return await getClient().stream(
        'agent.stream',
        { message, sessionId },
        (method, params) => {
          if (sender.isDestroyed()) return;
          if (method === AGENT.TOKEN) sender.send(PUSH.STREAM_TOKEN, params);
        }
      );
    } catch (err) {
      if (!sender.isDestroyed()) {
        sender.send(PUSH.STREAM_TOKEN, { token: '', error: err.message });
      }
      throw err;
    }
  });

  // --- OTA updater --------------------------------------------------------
  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    const { runUpdateCheck } = require('./update-check');
    return runUpdateCheck({ appRoot: process.cwd(), isDev: !app.isPackaged });
  });

  logger.info('ipc handlers registered');
}

module.exports = { registerIpcHandlers };
