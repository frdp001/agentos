import React, { useMemo, useState } from 'react';
import { api, useRpc } from '../lib/api.js';
import Panel from '../components/Panel.jsx';

const CATEGORIES = [
  { id: 'interested', label: 'Interested', className: 'text-sentiment-interested' },
  { id: 'objection', label: 'Objection', className: 'text-sentiment-objection' },
  { id: 'unsubscribe', label: 'Unsubscribe', className: 'text-sentiment-unsubscribe' },
];

export default function TriageInbox() {
  const { data: replies, loading } = useRpc('inbox.list');
  const [filter, setFilter] = useState('interested');
  const [busy, setBusy] = useState(null);

  const counts = useMemo(() => {
    const acc = { interested: 0, objection: 0, unsubscribe: 0 };
    (replies ?? []).forEach((r) => {
      if (acc[r.category] !== undefined) acc[r.category] += 1;
    });
    return acc;
  }, [replies]);

  const visible = (replies ?? []).filter((r) => r.category === filter);

  const reclassify = async (id, category) => {
    setBusy(id);
    try {
      await api.rpc('inbox.classify', { id, category });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
      <Panel title="Sentiment">
        <ul className="flex flex-col gap-1">
          {CATEGORIES.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setFilter(c.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm ${
                  filter === c.id ? 'bg-base-800 text-ink' : 'text-ink-muted hover:bg-base-800/60'
                }`}
              >
                <span className={c.className}>{c.label}</span>
                <span className="rounded-full bg-base-700 px-2 py-0.5 text-[11px] tabular-nums">
                  {counts[c.id] ?? 0}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={`Replies — ${filter}`}>
        {loading ? (
          <div className="text-sm text-ink-faint">Loading inbound replies…</div>
        ) : visible.length === 0 ? (
          <div className="text-sm text-ink-faint">No replies in this category.</div>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((r) => (
              <li key={r.id} className="rounded-lg border border-base-700 bg-base-800/60 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{r.subject}</span>
                  <span className="text-[11px] text-ink-faint">
                    {new Date(r.receivedAt).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-muted">{r.body}</p>
                <div className="mt-2 flex gap-2">
                  {CATEGORIES.filter((c) => c.id !== r.category).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => reclassify(r.id, c.id)}
                      className="btn-ghost px-2 py-0.5 text-[11px]"
                    >
                      Move to {c.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
