'use strict';

/**
 * EventBridge - a long-lived connection to the daemon socket that receives
 * unsolicited JSON-RPC notifications (new replies, persona changes, cron
 * ticks) and fans them out to the renderer plus native desktop notifications.
 *
 * Separate from RpcClient (which is request/response) because these events
 * are push-only and must survive for the lifetime of the app.
 */

const net = require('node:net');
const { Notification } = require('electron');
const logger = require('./logger');
const { PUSH } = require('@alaye/shared');

const RECONNECT_MS = 3000;

class EventBridge {
  /**
   * @param {{ socketPath: string, getWindows: () => Electron.BrowserWindow[] }} opts
   */
  constructor({ socketPath, getWindows }) {
    this.socketPath = socketPath;
    this.getWindows = getWindows;
    this.socket = null;
    this.buffer = '';
    this.stopped = false;
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  _connect() {
    if (this.stopped) return;
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    this.buffer = '';

    socket.on('connect', () => logger.info('event bridge connected'));
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => logger.debug('event bridge socket error', err.message));
    socket.on('close', () => {
      this.socket = null;
      if (this.stopped) return;
      this.timer = setTimeout(() => this._connect(), RECONNECT_MS);
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // Only server-initiated notifications (no id).
      if (msg.method && msg.id === undefined) this._dispatch(msg.method, msg.params || {});
    }
  }

  _dispatch(method, params) {
    for (const win of this.getWindows()) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(PUSH.DAEMON_EVENT, { method, params });
      }
    }

    if (method === 'reply.new') this._notifyReply(params);
  }

  _notifyReply(reply) {
    try {
      if (!Notification.isSupported()) return;
      const label = String(reply.category || 'reply').toUpperCase();
      new Notification({
        title: `${label} reply`,
        body: `${reply.from || 'A prospect'}: ${String(reply.subject || '').slice(0, 120)}`,
        silent: false,
      }).show();
    } catch (err) {
      logger.debug('desktop notification failed', err.message);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}

module.exports = { EventBridge };