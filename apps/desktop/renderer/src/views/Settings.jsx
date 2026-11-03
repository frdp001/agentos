import React, { useEffect, useState } from 'react';
import { api, useRpc } from '../lib/api.js';
import Panel from '../components/Panel.jsx';

const SECRET_FIELDS = [
  { key: 'openai_api_key', label: 'OpenAI API key', provider: 'openai', kind: 'remote' },
  { key: 'anthropic_api_key', label: 'Anthropic API key', provider: 'anthropic', kind: 'remote' },
  { key: 'composio_api_key', label: 'Composio API key', provider: 'composio', kind: 'email' },
  { key: 'resend_api_key', label: 'Resend API key', provider: 'resend', kind: 'email' },
  { key: 'sendgrid_api_key', label: 'SendGrid API key', provider: 'sendgrid', kind: 'email' },
];

export default function Settings() {
  const { data: providers } = useRpc('providers.list');
  const [present, setPresent] = useState({});
  const [backend, setBackend] = useState('');
  const [values, setValues] = useState({});
  const [ollama, setOllama] = useState('http://127.0.0.1:11434');
  const [status, setStatus] = useState('');

  // Editable OpenAI-compatible provider (Token Harbor) settings.
  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [providerSource, setProviderSource] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);

  useEffect(() => {
    (async () => {
      const [info, defaults, savedProvider, savedBase, savedModel] = await Promise.all([
        api.listSecrets(),
        api.providerDefaults(),
        api.getSetting('provider'),
        api.getSetting('openai_base_url'),
        api.getSetting('default_model'),
      ]);
      setPresent(info?.present ?? {});
      setBackend(info?.backend ?? '');

      // Pre-populate from the bundled config unless already saved explicitly.
      setProvider(savedProvider ?? defaults?.provider ?? '');
      setBaseUrl(savedBase ?? defaults?.openai_base_url ?? '');
      setDefaultModel(savedModel ?? defaults?.default_model ?? '');
      setProviderSource(defaults?.source ?? '');
      setHasApiKey(Boolean(info?.present?.openai_api_key) || Boolean(defaults?.hasApiKey));
    })();
  }, []);

  const saveProvider = async () => {
    await api.setSetting('provider', provider);
    await api.setSetting('openai_base_url', baseUrl);
    await api.setSetting('default_model', defaultModel);
    setStatus('Provider settings saved');
    setTimeout(() => setStatus(''), 1500);
  };

  const saveSecret = async (key) => {
    const value = values[key];
    if (!value) return;
    await api.setSecret(key, value);
    setPresent((p) => ({ ...p, [key]: true }));
    setValues((v) => ({ ...v, [key]: '' }));
    setStatus(`Saved ${key}`);
    setTimeout(() => setStatus(''), 1500);
  };

  return (
    <div className="flex flex-col gap-6">
      <Panel title="Providers & Credentials">
        <div className="mb-3 flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="h-1.5 w-1.5 rounded-full bg-sentiment-interested" />
          Credential backend: {backend || 'detecting…'}
        </div>
        <div className="flex flex-col gap-4">
          {SECRET_FIELDS.map((f) => (
            <div key={f.key} className="flex items-center gap-3">
              <div className="w-48 text-sm text-ink-muted">{f.label}</div>
              <input
                type="password"
                className="field flex-1"
                placeholder={present[f.key] ? '•••••••• (configured)' : 'sk-…'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
              <button type="button" className="btn-primary" onClick={() => saveSecret(f.key)}>
                Save
              </button>
            </div>
          ))}

          <div className="flex items-center gap-3">
            <div className="w-48 text-sm text-ink-muted">Ollama / llama.cpp endpoint</div>
            <input className="field flex-1" value={ollama} onChange={(e) => setOllama(e.target.value)} />
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                await api.setSetting('ollama_endpoint', ollama);
                setStatus('Ollama endpoint saved');
                setTimeout(() => setStatus(''), 1500);
              }}
            >
              Save
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="OpenAI-Compatible Endpoint (Token Harbor)">
        <div className="mb-3 flex items-center gap-2 text-[11px] text-ink-faint">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              hasApiKey ? 'bg-sentiment-interested' : 'bg-sentiment-objection'
            }`}
          />
          API key {hasApiKey ? 'configured' : 'not set'}
          {providerSource ? ` · config: ${providerSource}` : ''}
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="w-48 text-sm text-ink-muted">Provider</div>
            <input
              className="field flex-1"
              placeholder="token-harbor"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="w-48 text-sm text-ink-muted">Base URL</div>
            <input
              className="field flex-1"
              placeholder="https://api.tokenharbor.ai/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="w-48 text-sm text-ink-muted">Default model</div>
            <input
              className="field flex-1"
              placeholder="qwen2.5-coder"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={saveProvider}>
              Save provider settings
            </button>
          </div>
          <p className="text-[11px] text-ink-faint">
            These map to <code>OPENAI_BASE_URL</code>, <code>DEFAULT_MODEL</code> and the active
            provider passed to the embedded engine. The API key is stored separately in the field
            above (keychain).
          </p>
        </div>
      </Panel>

      <Panel title="Detected Provider Status">
        <ul className="flex flex-col gap-2">
          {(providers ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between text-sm">
              <span className="font-mono text-xs text-ink">{p.id}</span>
              <div className="flex items-center gap-2">
                <span className="rounded bg-base-800 px-2 py-0.5 text-[11px] text-ink-muted">{p.kind}</span>
                <span
                  className={`h-2 w-2 rounded-full ${
                    p.configured ? 'bg-sentiment-interested' : 'bg-ink-faint'
                  }`}
                />
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Engine">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-muted">Check for OTA updates (skills, templates, patches)</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              setStatus('Checking…');
              try {
                await api.rpc('update.check');
                setStatus('Up to date');
              } catch {
                setStatus('Update check failed');
              }
              setTimeout(() => setStatus(''), 2500);
            }}
          >
            Check now
          </button>
        </div>
        {status && <div className="mt-3 text-xs text-accent-glow">{status}</div>}
      </Panel>
    </div>
  );
}
