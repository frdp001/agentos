import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, useRpc } from '../lib/api.js';
import Panel from '../components/Panel.jsx';

const VARIABLES = ['first_name', 'company', 'pain_point', 'role', 'sender_name'];

const SAMPLE = {
  first_name: 'Ada',
  company: 'Northwind',
  pain_point: 'manual lead qualification',
  role: 'Head of Sales',
  sender_name: 'Jordan',
};

function render(body) {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => SAMPLE[key] ?? `«${key}»`);
}

export default function TemplateEditor() {
  const { data: templates } = useRpc('template.list');
  const [body, setBody] = useState(
    'Hi {{first_name}},\n\nSaw {{company}} is scaling — many teams like yours struggle with {{pain_point}}.\n\nWorth a quick chat?\n\n— {{sender_name}}'
  );
  const [name, setName] = useState('Cold Intro');
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);

  const preview = useMemo(() => render(body), [body]);

  // Hydrate from the persisted store (~/.alaye-os/data/templates.json) once.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    api
      .rpc('template.get', { id: 'tpl-intro' })
      .then((tpl) => {
        if (tpl?.body) setBody(tpl.body);
        if (tpl?.name) setName(tpl.name);
      })
      .catch(() => {
        /* no persisted template yet - keep the default draft */
      });
  }, []);

  const save = async () => {
    await api.rpc('template.save', { id: 'tpl-intro', name, body });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const insert = (v) => setBody((b) => `${b}{{${v}}}`);

  return (
    <div className="grid h-full grid-cols-1 gap-6 lg:grid-cols-2">
      <Panel
        title="Editor"
        action={
          <div className="flex items-center gap-2 pr-3">
            {saved && <span className="text-xs text-sentiment-interested">Saved</span>}
            <button type="button" className="btn-primary" onClick={save}>
              Save template
            </button>
          </div>
        }
      >
        <div className="flex h-full flex-col gap-3">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" />
          <div className="flex flex-wrap gap-1.5">
            {VARIABLES.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => insert(v)}
                className="rounded-md border border-base-600 px-2 py-0.5 font-mono text-[11px] text-ink-muted hover:border-accent hover:text-ink"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <textarea
            className="field min-h-0 flex-1 resize-none font-mono text-[13px] leading-relaxed"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
          />
          <div className="text-[11px] text-ink-faint">
            {templates?.length ?? 0} template(s) stored
          </div>
        </div>
      </Panel>

      <Panel title="Live Preview">
        <pre className="h-full overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink">
          {preview}
        </pre>
      </Panel>
    </div>
  );
}
