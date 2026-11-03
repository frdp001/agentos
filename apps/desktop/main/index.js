'use strict';

/**
 * Alaye OS - Electron main process entrypoint.
 *
 * Responsibilities:
 *   1. Enforce a single-instance lock (one daemon, one UI).
 *   2. Provision and supervise the local Hermes gateway daemon.
 *   3. Create the dark-mode application shell.
 *   4. Wire the secure IPC bridge between renderer and daemon socket.
 *   5. Tear everything down cleanly on quit.
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const logger = require('./logger');
const { DaemonManager } = require('./daemon-manager');
const { EventBridge } = require('./event-bridge');
const { createMainWindow } = require('./window');
const { registerIpcHandlers } = require('./ipc-handlers');
const { runUpdateCheck } = require('./update-check');

const IS_DEV = process.env.ALAYE_DEV === '1' || !app.isPackaged;
const APP_ROOT = path.resolve(__dirname, '..');

/** @type {DaemonManager | null} */
let daemon = null;
/** @type {EventBridge | null} */
let events = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

/**
 * A second launch focuses the existing window rather than booting a
 * competing daemon (which would collide on the gateway socket).
 */
if (!app.requestSingleInstanceLock()) {
  logger.warn('secondary instance detected - quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  bootstrap();
}

function bootstrap() {
  app.setName('Alaye OS');
  app.setAppUserModelId('os.alaye.desktop');

  // The daemon must never start before Chromium is ready to hold its pipe.
  app.whenReady().then(onReady).catch((err) => {
    logger.error('fatal during app startup', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openShell();
  });

  app.on('before-quit', async (event) => {
    if (!daemon || daemon.stopping) return;
    event.preventDefault();
    daemon.stopping = true;
    events?.stop();
    await daemon.stop();
    app.quit();
  });
}

async function onReady() {
  hardenSession();
  registerIpcHandlers();

  daemon = new DaemonManager({ appRoot: APP_ROOT, isDev: IS_DEV });
  try {
    await daemon.start();
    logger.info(`hermes gateway online on ${daemon.socketPath}`);
  } catch (err) {
    // A dead gateway is recoverable: the UI renders a degraded state and
    // offers a manual restart from Settings.
    logger.error('gateway failed to start', err);
  }

  // Subscribe to daemon push events (inbound replies, persona changes) for
  // desktop alerts and live UI updates. Reconnects automatically.
  events = new EventBridge({
    socketPath: daemon.socketPath,
    getWindows: () => BrowserWindow.getAllWindows(),
  });
  events.start();

  openShell();

  // Non-blocking OTA sweep; failures are surfaced in the UI, never fatal.
  runUpdateCheck({ appRoot: APP_ROOT, isDev: IS_DEV }).catch((err) =>
    logger.warn('update check skipped', err)
  );
}

function openShell() {
  mainWindow = createMainWindow({ isDev: IS_DEV, devServerUrl: process.env.ALAYE_RENDERER_URL });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Deny all permission prompts and lock the CSP posture. The renderer needs
 * no camera/mic/geolocation; anything asking for them is hostile.
 */
function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}
