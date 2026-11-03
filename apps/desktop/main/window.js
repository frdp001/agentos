'use strict';

const { BrowserWindow, shell } = require('electron');
const path = require('node:path');

const BACKGROUND = '#0b0d12';

/**
 * Creates the single framed shell window. Uses the native frame but forces
 * the dark titlebar so it blends with the Hermes panel aesthetic.
 *
 * @param {{ isDev: boolean, devServerUrl?: string }} opts
 * @returns {BrowserWindow}
 */
function createMainWindow({ isDev, devServerUrl }) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: BACKGROUND,
    title: 'Alaye OS',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // External links open in the OS browser, never inside the privileged shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && devServerUrl && url.startsWith(devServerUrl);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev && devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  }

  return win;
}

module.exports = { createMainWindow };
