import React from 'react';

const NAV = [
  { id: 'chat', label: 'Chat Console', hint: 'Talk to the agent' },
  { id: 'campaigns', label: 'Campaigns', hint: 'Live outreach metrics' },
  { id: 'templates', label: 'Templates', hint: 'Markdown + variables' },
  { id: 'inbox', label: 'Triage Inbox', hint: 'Replies by sentiment' },
  { id: 'memory', label: 'Memory Vault', hint: 'Obsidian second brain' },
  { id: 'settings', label: 'Settings', hint: 'Providers & keys' },
];

export default function Sidebar({ view, onNavigate, health }) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-base-700 bg-base-900/60">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-white">
          A
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink">Alaye OS</div>
          <div className="text-[10px] uppercase tracking-widest text-ink-faint">outreach agent</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1 px-2 py-2">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={`nav-item ${view === item.id ? 'nav-item-active' : ''}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
            <span className="flex flex-col items-start">
              <span>{item.label}</span>
              <span className="text-[10px] text-ink-faint">{item.hint}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="mt-auto border-t border-base-700 p-4">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              health.online ? 'bg-sentiment-interested' : 'bg-sentiment-unsubscribe'
            }`}
          />
          <span className="text-ink-muted">
            Hermes gateway {health.online ? 'online' : health.checking ? 'connecting…' : 'offline'}
          </span>
        </div>
      </div>
    </aside>
  );
}
