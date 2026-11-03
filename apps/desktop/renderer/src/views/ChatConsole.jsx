import React, { useEffect, useRef, useState } from 'react';
import { api, useRpc } from '../lib/api.js';
import Markdown from '../lib/markdown.jsx';

const QUICK_ACTIONS = [
  { label: 'Draft Cold Email', prompt: 'Draft a cold email for a SaaS founder.' },
  { label: 'Analyze Inbox Objections', prompt: 'Analyze inbox objections.' },
  { label: 'Pause Campaign', prompt: 'Pause the active campaign.' },
];

const WELCOME = {
  id: 'welcome',
  role: 'agent',
  content:
    '## Hermes Agent Console\n\nConnected to the embedded outreach engine. ' +
    'Ask me to draft outreach, analyze replies, manage campaigns, or render templates.',
};

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="flex max-w-[82%] gap-3">
        {!isUser && (
          <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent text-[11px] font-bold text-white">
            H
          </div>
        )}
        <div
          className={`rounded-xl px-3.5 py-2.5 ${
            isUser
              ? 'bg-accent/20 text-ink'
              : message.error
                ? 'border border-sentiment-unsubscribe/40 bg-base-800'
                : 'border border-base-700 bg-base-800/70'
          }`}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap text-sm text-ink">{message.content}</p>
          ) : message.streaming && !message.content ? (
            <TypingDots />
          ) : (
            <Markdown text={message.content} streaming={message.streaming} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatConsole() {
  const { data: providers } = useRpc('providers.list');
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const idRef = useRef(0);
  const nextId = () => `m${++idRef.current}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const activeProvider =
    (providers ?? []).find((p) => p.configured) ?? (providers ?? [])[0] ?? null;

  const send = async (raw) => {
    const content = (raw ?? input).trim();
    if (!content || busy) return;
    setInput('');
    setBusy(true);

    const agentId = nextId();
    setMessages((m) => [
      ...m,
      { id: nextId(), role: 'user', content },
      { id: agentId, role: 'agent', content: '', streaming: true },
    ]);

    const append = (token) =>
      setMessages((m) =>
        m.map((msg) => (msg.id === agentId ? { ...msg, content: msg.content + token } : msg))
      );

    try {
      const result = await api.agentChat(content, { sessionId, onToken: append });
      setMessages((m) =>
        m.map((msg) =>
          msg.id === agentId
            ? { ...msg, content: result?.reply ?? msg.content, streaming: false }
            : msg
        )
      );
      if (result?.sessionId) setSessionId(result.sessionId);
    } catch (err) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === agentId
            ? { ...msg, content: `**Engine error:** ${err.message}`, streaming: false, error: true }
            : msg
        )
      );
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setSessionId(null);
    setBusy(false);
    setMessages([WELCOME]);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-base-700 bg-base-900/60 shadow-panel">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-base-700 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`h-2 w-2 rounded-full ${
              activeProvider ? 'bg-sentiment-interested' : 'bg-ink-faint'
            }`}
          />
          <span className="font-medium text-ink">
            {activeProvider ? `${activeProvider.id}` : 'no provider'}
          </span>
          <span className="rounded bg-base-800 px-2 py-0.5 text-[11px] text-ink-muted">
            {activeProvider?.kind ?? 'offline'}
          </span>
        </div>
        <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={reset}>
          Reset session
        </button>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2 border-b border-base-700 px-4 py-2">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={busy}
            onClick={() => send(action.prompt)}
            className="rounded-full border border-base-600 px-3 py-1 text-xs text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-40"
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>

      {/* Composer */}
      <div className="border-t border-base-700 p-3">
        <div className="flex items-end gap-2">
          <textarea
            className="field max-h-40 min-h-[44px] flex-1 resize-none"
            placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="button" className="btn-primary h-11" disabled={busy || !input.trim()} onClick={() => send()}>
            {busy ? 'Streaming…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
