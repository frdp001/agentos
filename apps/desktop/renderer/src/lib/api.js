import React from 'react';

// Thin renderer-side wrapper over the preload bridge (window.alaye).
// When running in a plain browser (vite dev without Electron) a mock shim is
// installed so the UI remains inspectable.

const bridge = typeof window !== 'undefined' ? window.alaye : undefined;

// Chat transport prefers the public electronAPI surface, falling back to the
// internal `alaye` bridge, then to a mock when running in a plain browser.
const chatTransport = (() => {
  if (typeof window === 'undefined') return null;
  if (window.electronAPI) {
    return { chat: window.electronAPI.agentChat, onToken: window.electronAPI.onStreamToken };
  }
  if (window.alaye?.agent) {
    return { chat: window.alaye.agent.chat, onToken: window.alaye.agent.onStreamToken };
  }
  return null;
})();

const MOCK = {
  'daemon.ping': { pong: true },
  'campaign.metrics': {
    sent: 1284,
    replies: 137,
    interested: 41,
    responseRate: 0.1067,
    positiveRate: 0.2993,
    active: 1,
  },
  'campaign.list': [
    { id: 'c1', name: 'Q4 SaaS Founders', status: 'active', sent: 1284, replies: 137, interested: 41 },
  ],
  'template.list': [{ id: 'tpl-intro', name: 'Cold Intro', updatedAt: Date.now() }],
  'inbox.list': [
    { id: 'r1', subject: 'Interested', body: 'Sounds interesting, can you send pricing?', category: 'interested', receivedAt: Date.now() },
    { id: 'r2', subject: 'Unsubscribe', body: 'Please remove me.', category: 'unsubscribe', receivedAt: Date.now() },
    { id: 'r3', subject: 'Objection', body: 'We already have a vendor.', category: 'objection', receivedAt: Date.now() },
  ],
  'providers.list': [
    { id: 'openai', kind: 'remote', configured: false },
    { id: 'anthropic', kind: 'remote', configured: false },
    { id: 'ollama', kind: 'local', configured: true },
  ],
  'cron.list': [
    { name: 'inbox-poll', interval: '*/2 * * * *' },
    { name: 'send-queue', interval: '* * * * *' },
    { name: 'lead-scoring', interval: '0 3 * * *' },
  ],
};

let mockCall = null;

export const api = {
  isEmbedded: Boolean(bridge),

  async rpc(method, params = {}) {
    if (bridge) return bridge.daemon.call(method, params);
    if (!mockCall) mockCall = MOCK[method];
    return mockCall ?? null;
  },

  async daemonHealth() {
    if (bridge) return bridge.daemon.health();
    return { online: true, version: 'dev' };
  },

  async getSetting(key) {
    return bridge ? bridge.settings.get(key) : null;
  },
  async setSetting(key, value) {
    return bridge ? bridge.settings.set(key, value) : true;
  },
  async setSecret(key, value) {
    return bridge ? bridge.secrets.set(key, value) : true;
  },
  async hasSecret(key) {
    return bridge ? bridge.secrets.has(key) : false;
  },
  async listSecrets() {
    return bridge ? bridge.secrets.list() : { backend: 'mock', present: {} };
  },
  async deleteSecret(key) {
    return bridge ? bridge.secrets.delete(key) : true;
  },

  async providerDefaults() {
    if (bridge?.provider?.defaults) return bridge.provider.defaults();
    return {
      provider: 'token-harbor',
      openai_base_url: 'https://api.tokenharbor.ai/v1',
      default_model: 'qwen2.5-coder',
      hasApiKey: false,
      source: null,
    };
  },

  onEvent(channel, handler) {
    return bridge ? bridge.onEvent(channel, handler) : () => {};
  },

  /** Subscribe to daemon push events (reply.new, persona.changed, …). */
  onDaemonEvent(handler) {
    if (bridge?.onDaemonEvent) return bridge.onDaemonEvent(handler);
    return () => {};
  },

  /**
   * Send a chat message and stream tokens to `onToken`.
   * @param {string} message
   * @param {{ onToken?: (token: string) => void, sessionId?: string }} [opts]
   * @returns {Promise<{ sessionId: string, reply: string }>}
   */
  async agentChat(message, { onToken, sessionId } = {}) {
    if (chatTransport) {
      const unsub = chatTransport.onToken((payload) => {
        if (!payload) return;
        if (payload.error) return;
        if (typeof payload.token === 'string' && payload.token) onToken?.(payload.token);
      });
      try {
        return await chatTransport.chat(message, sessionId);
      } finally {
        unsub?.();
      }
    }
    // Browser mock: stream a canned reply so the console is inspectable.
    const reply =
      `## Hermes Agent (mock)\n\nYou said: _${message}_\n\n` +
      '```text\nrunning without the Electron bridge\n```';
    const chunks = reply.match(/[\s\S]{1,20}/g) || [reply];
    for (const chunk of chunks) {
      onToken?.(chunk);
      await new Promise((r) => setTimeout(r, 16));
    }
    return { sessionId: 'mock', reply };
  },
};

export function useRpc(method, params = {}, deps = []) {
  const [state, setState] = React.useState({ data: null, error: null, loading: true });
  React.useEffect(() => {
    let active = true;
    setState((s) => ({ ...s, loading: true }));
    api
      .rpc(method, params)
      .then((data) => active && setState({ data, error: null, loading: false }))
      .catch((error) => active && setState({ data: null, error, loading: false }));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
