'use strict';

/**
 * Context-isolated bridge. The renderer gets a narrow, explicitly enumerated
 * surface - never `ipcRenderer` itself, never Node primitives.
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  version: process.versions.electron,

  settings: {
    get: (key) => ipcRenderer.invoke('alaye:settings:get', key),
    set: (key, value) => ipcRenderer.invoke('alaye:settings:set', key, value),
  },

  secrets: {
    set: (key, value) => ipcRenderer.invoke('alaye:secrets:set', key, value),
    has: (key) => ipcRenderer.invoke('alaye:secrets:has', key),
    list: () => ipcRenderer.invoke('alaye:secrets:list'),
    delete: (key) => ipcRenderer.invoke('alaye:secrets:delete', key),
  },

  provider: {
    /** Default provider settings from the bundled/edited config. */
    defaults: () => ipcRenderer.invoke('alaye:provider:defaults'),
  },

  /** Subscribe to daemon push events (inbound replies, persona changes). */
  onDaemonEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('alaye:daemon:event', listener);
    return () => ipcRenderer.removeListener('alaye:daemon:event', listener);
  },

  daemon: {
    health: () => ipcRenderer.invoke('alaye:daemon:health'),
    /** @param {string} method @param {object} [params] */
    call: (method, params) => ipcRenderer.invoke('alaye:rpc', method, params),
  },

  agent: {
    /** Send a chat message; tokens arrive via onStreamToken. */
    chat: (message, sessionId) => ipcRenderer.invoke('alaye:agent:chat', message, sessionId),
    /** Subscribe to streamed tokens. Returns an unsubscribe function. */
    onStreamToken: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('alaye:stream-token', listener);
      return () => ipcRenderer.removeListener('alaye:stream-token', listener);
    },
  },

  updater: {
    check: () => ipcRenderer.invoke('alaye:update:check'),
  },

  /**
   * Subscribe to daemon-pushed events (new replies, lead status changes,
   * cron loop ticks). Returns an unsubscribe function.
   */
  onEvent: (channel, handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('alaye', Object.freeze(api));

/**
 * Public, task-specified surface. Kept intentionally small and stable:
 *   window.electronAPI.agentChat(message) -> Promise<result>
 *   window.electronAPI.onStreamToken(cb)  -> unsubscribe()
 */
const electronAPI = Object.freeze({
  agentChat: (message, sessionId) => api.agent.chat(message, sessionId),
  onStreamToken: (handler) => api.agent.onStreamToken(handler),
});

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
