import React from 'react';
import { useRpc } from '../lib/api.js';
import Panel from '../components/Panel.jsx';
import MetricCard from '../components/MetricCard.jsx';

const pct = (n) => `${((n ?? 0) * 100).toFixed(1)}%`;

export default function CampaignDashboard() {
  const { data: metrics, loading } = useRpc('campaign.metrics');
  const { data: campaigns } = useRpc('campaign.list');
  const { data: loops } = useRpc('cron.list');

  const m = metrics ?? {};

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Sent" value={loading ? '—' : m.sent ?? 0} sub="outreach emails delivered" />
        <MetricCard
          label="Response rate"
          value={loading ? '—' : pct(m.responseRate)}
          sub={`${m.replies ?? 0} replies`}
          tone="good"
        />
        <MetricCard
          label="Positive rate"
          value={loading ? '—' : pct(m.positiveRate)}
          sub={`${m.interested ?? 0} interested`}
          tone="good"
        />
        <MetricCard label="Active campaigns" value={loading ? '—' : m.active ?? 0} sub="running now" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Panel title="Campaigns" className="lg:col-span-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Sent</th>
                <th className="pb-2 text-right font-medium">Replies</th>
                <th className="pb-2 text-right font-medium">Interested</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-700">
              {(campaigns ?? []).map((c) => (
                <tr key={c.id} className="text-ink">
                  <td className="py-2.5">{c.name}</td>
                  <td className="py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        c.status === 'active'
                          ? 'bg-sentiment-interested/15 text-sentiment-interested'
                          : 'bg-base-700 text-ink-muted'
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{c.sent}</td>
                  <td className="py-2.5 text-right tabular-nums">{c.replies}</td>
                  <td className="py-2.5 text-right tabular-nums">{c.interested}</td>
                </tr>
              ))}
              {!campaigns?.length && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-ink-faint">
                    No campaigns yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>

        <Panel title="Background Loops">
          <ul className="flex flex-col gap-3">
            {(loops ?? []).map((loop) => (
              <li key={loop.name} className="flex items-center justify-between text-sm">
                <span className="font-mono text-xs text-ink">{loop.name}</span>
                <span className="rounded bg-base-800 px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                  {loop.interval}
                </span>
              </li>
            ))}
            {!loops?.length && <li className="text-ink-faint">No active loops.</li>}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
