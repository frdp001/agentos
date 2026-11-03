import React from 'react';

export default function MetricCard({ label, value, sub, tone = 'default' }) {
  const toneClass =
    tone === 'good'
      ? 'text-sentiment-interested'
      : tone === 'bad'
        ? 'text-sentiment-unsubscribe'
        : 'text-ink';

  return (
    <div className="panel p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}
