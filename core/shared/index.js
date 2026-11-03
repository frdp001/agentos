'use strict';

/** Cross-cutting constants shared by the shell, daemon and updater. */
module.exports = {
  APP_ID: 'os.alaye.desktop',
  APP_NAME: 'Alaye OS',
  SOCKET_NAME: process.platform === 'win32' ? '\\\\.\\pipe\\alaye-os-hermes' : 'alaye-hermes.sock',

  /** Renderer -> main IPC channels. */
  IPC: {
    RPC: 'alaye:rpc',
    SETTINGS_GET: 'alaye:settings:get',
    SETTINGS_SET: 'alaye:settings:set',
    SECRET_SET: 'alaye:secrets:set',
    SECRET_HAS: 'alaye:secrets:has',
    SECRET_LIST: 'alaye:secrets:list',
    SECRET_DELETE: 'alaye:secrets:delete',
    DAEMON_HEALTH: 'alaye:daemon:health',
    UPDATE_CHECK: 'alaye:update:check',
    AGENT_CHAT: 'alaye:agent:chat',
    PROVIDER_DEFAULTS: 'alaye:provider:defaults',
  },

  /** Main -> renderer push channels. */
  PUSH: {
    STREAM_TOKEN: 'alaye:stream-token',
    DAEMON_EVENT: 'alaye:daemon:event',
  },

  /** Daemon JSON-RPC notification methods used for streaming. */
  AGENT: {
    TOKEN: 'agent.token',
    DONE: 'agent.done',
    ERROR: 'agent.error',
  },

  /** Reply sentiment categories used across triage UI and engine. */
  REPLY_CATEGORIES: ['interested', 'objection', 'unsubscribe'],

  /** Allow-listed secret keys. Anything else is rejected by the IPC layer. */
  SECRET_KEYS: [
    'openai_api_key',
    'anthropic_api_key',
    'composio_api_key',
    'resend_api_key',
    'sendgrid_api_key',
    'smtp_password',
    'imap_password',
    'gmail_oauth_token',
    'outlook_oauth_token',
  ],
};
