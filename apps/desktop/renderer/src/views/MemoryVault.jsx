import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const CATEGORIES = [
  { id: '', label: 'All notes' },
  { id: 'leads', label: 'Leads' },
  { id: 'objections', label: 'Objections' },
  { id: 'company_context', label: 'Company context' },
];

export default function MemoryVault() {
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  const load = async (cat) => {
    try {
      const rows = await api.rpc('memory.list', cat ? { category: cat } : {});
      setNotes(Array.isArray(rows) ? rows : []);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load(category);
    setMatches(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const runSearch = async () => {
    if (!query.trim()) {
      setMatches(null);
      return;
    }
    try {
      const rows = await api.rpc('memory.search', { query });
      setMatches(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.message);
    }
  };

  const openNote = async (note) => {
    try {
      const full = await api.rpc('memory.read', { category: note.category, slug: note.slug });
      setSelected(full);
    } catch (err) {
      setError(err.message);
    }
  };

  const visible = matches ?? notes;

  return (
    <div className="grid h-full grid-cols-1 gap-6 lg:grid-cols-[220px_320px_1fr]">
      <section className="panel flex flex-col">
        <h2 className="panel-title border-b border-base-700">Vault</h2>
        <div className="flex flex-col gap-1 p-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id || 'all'}
              type="button"
              onClick={() => setCategory(c.id)}
              className={`rounded-lg px-3 py-2 text-left text-sm ${
                category === c.id ? 'bg-base-800 text-ink' : 'text-ink-muted hover:bg-base-800/60'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="mt-auto border-t border-base-700 p-3 text-[11px] text-ink-faint">
          Markdown files · ~/.alaye-os/memory
        </div>
      </section>

      <section className="panel flex min-h-0 flex-col">
        <div className="flex gap-2 border-b border-base-700 p-2">
          <input
            className="field"
            placeholder="Search memory…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
          <button type="button" className="btn-ghost px-2" onClick={runSearch}>
            Go
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-auto p-2">
          {visible.map((note) => (
            <li key={`${note.category}/${note.slug}`}>
              <button
                type="button"
                onClick={() => openNote(note)}
                className="w-full rounded-lg px-3 py-2 text-left hover:bg-base-800/60"
              >
                <div className="text-sm text-ink">{note.title || note.slug}</div>
                <div className="text-[11px] text-ink-faint">
                  {note.category}
                  {note.score ? ` · ${note.score} match(es)` : ''}
                </div>
              </button>
            </li>
          ))}
          {!visible.length && <li className="px-3 py-4 text-sm text-ink-faint">No notes.</li>}
        </ul>
      </section>

      <section className="panel flex min-h-0 flex-col">
        <h2 className="panel-title border-b border-base-700">
          {selected ? `${selected.category} / ${selected.slug}.md` : 'Note'}
        </h2>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error && <div className="mb-3 text-sm text-sentiment-unsubscribe">{error}</div>}
          {selected ? (
            <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-ink">
              {selected.body}
            </pre>
          ) : (
            <div className="text-sm text-ink-faint">Select a note to read it.</div>
          )}
        </div>
      </section>
    </div>
  );
}