import React from 'react';

const TITLES = {
  chat: 'Chat Console',
  campaigns: 'Campaign Dashboard',
  templates: 'Template Editor',
  inbox: 'Triage & Lead Inbox',
  memory: 'Memory Vault',
  settings: 'Settings & Provider Setup',
};

export default function Topbar({ view, health }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-base-700 bg-base-900/40 px-6">
      <h1 className="text-sm font-semibold text-ink">{TITLES[view]}</h1>
      <div className="flex items-center gap-3">
        <span className="rounded-full border border-base-600 px-2.5 py-1 text-[11px] text-ink-muted">
          v{health.version ?? '0.1.0'}
        </span>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] ${
            health.online
              ? 'bg-sentiment-interested/15 text-sentiment-interested'
              : 'bg-sentiment-unsubscribe/15 text-sentiment-unsubscribe'
          }`}
        >
          {health.online ? 'Engine connected' : 'Engine offline'}
        </span>
      </div>
    </header>
  );
}
