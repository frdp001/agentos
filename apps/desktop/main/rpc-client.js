'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const logger = require('./logger');

/**
 * Minimal newline-delimited JSON-RPC client for the Hermes gateway socket.
 * One short-lived connection per call keeps failure isolation simple; the
 * daemon is cheap to connect to on loopback.
 */
class RpcClient {
  /** @param {string} socketPath */
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.timeoutMs = 30000;
    this.streamTimeoutMs = 180000;
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  call(method, params = {}) {
    const id = crypto.randomUUID();
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      let buffer = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`RPC timeout: ${method}`));
      }, this.timeoutMs);

      const settle = (fn, value) => {
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };

      socket.on('connect', () => socket.write(payload));
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          // Ignore server-initiated notifications that may arrive before the
          // response (e.g. persona.changed emitted during the same call).
          if (msg.id !== id) continue;
          if (msg.error) settle(reject, new Error(msg.error.message || 'daemon error'));
          else settle(resolve, msg.result);
          return;
        }
      });
      socket.on('error', (err) => {
        logger.debug(`rpc socket error on ${method}`, err.message);
        settle(reject, err);
      });
    });
  }

  /**
   * Streaming call. Keeps the connection open and routes JSON-RPC
   * notifications (frames with no matching id) to `onNotification` until the
   * final response frame resolves the promise.
   *
   * @param {string} method
   * @param {object} params
   * @param {(method: string, params: object) => void} onNotification
   * @returns {Promise<any>}
   */
  stream(method, params, onNotification = () => {}) {
    const id = crypto.randomUUID();
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      let buffer = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`RPC stream timeout: ${method}`));
      }, this.streamTimeoutMs);

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };

      socket.on('connect', () => socket.write(payload));
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === id) {
            if (msg.error) finish(reject, new Error(msg.error.message || 'daemon stream error'));
            else finish(resolve, msg.result);
          } else if (msg.method) {
            try {
              onNotification(msg.method, msg.params || {});
            } catch (err) {
              logger.warn(`stream notification handler failed for ${method}`, err.message);
            }
          }
        }
      });
      socket.on('error', (err) => finish(reject, err));
    });
  }
}

module.exports = { RpcClient };
