import React from 'react';

/**
 * Minimal, dependency-free markdown renderer tuned for agent chat output.
 * Returns React nodes (never HTML strings) so untrusted model output cannot
 * inject markup. Supports headings, lists, blockquotes, fenced code blocks
 * (with a naive syntax highlighter) and inline emphasis/code/links.
 */

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

function renderInline(text, keyPrefix) {
  const nodes = [];
  let last = 0;
  let match;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const k = `${keyPrefix}-i${key++}`;
    if (token.startsWith('`')) {
      nodes.push(
        <code key={k} className="rounded bg-base-700 px-1 py-0.5 font-mono text-[0.82em] text-accent-glow">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={k} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*')) {
      nodes.push(
        <em key={k} className="italic text-ink-muted">
          {token.slice(1, -1)}
        </em>
      );
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('](') + 2, -1);
      nodes.push(
        <a key={k} href={href} target="_blank" rel="noreferrer" className="text-accent-glow underline">
          {label}
        </a>
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*)|(`[^`]*`|"[^"]*"|'[^']*')|(\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|new|try|catch|finally|throw|def|self|None|True|False|print|echo|SELECT|FROM|WHERE)\b)/g;

function highlight(code) {
  const out = [];
  let last = 0;
  let match;
  let key = 0;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(code)) !== null) {
    if (match.index > last) out.push(code.slice(last, match.index));
    const k = `h${key++}`;
    if (match[1]) out.push(<span key={k} className="text-ink-faint">{match[0]}</span>);
    else if (match[2]) out.push(<span key={k} className="text-sentiment-interested">{match[0]}</span>);
    else if (match[3]) out.push(<span key={k} className="text-sentiment-objection">{match[0]}</span>);
    else out.push(<span key={k} className="text-accent-glow">{match[0]}</span>);
    last = match.index + match[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({ code, lang, id }) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-base-700 bg-base-950">
      <div className="flex items-center justify-between border-b border-base-700 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{lang || 'text'}</span>
      </div>
      <pre className="overflow-auto p-3 font-mono text-[12.5px] leading-relaxed text-ink">
        <code>{highlight(code)}</code>
      </pre>
    </div>
  );
}

export default function Markdown({ text = '', streaming = false }) {
  const nodes = [];
  const lines = text.split('\n');
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      nodes.push(<CodeBlock key={`b${blockKey++}`} code={code.join('\n')} lang={lang} />);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const sizes = ['text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-xs'];
      nodes.push(
        <div key={`b${blockKey++}`} className={`mt-4 mb-1.5 font-semibold text-ink ${sizes[level - 1]}`}>
          {renderInline(heading[2], `h${blockKey}`)}
        </div>
      );
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ul key={`b${blockKey++}`} className="my-2 list-disc space-y-1 pl-5 text-ink">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ul${blockKey}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ol key={`b${blockKey++}`} className="my-2 list-decimal space-y-1 pl-5 text-ink">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ol${blockKey}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    nodes.push(
      <p key={`b${blockKey++}`} className="my-1.5 leading-relaxed text-ink">
        {renderInline(para.join(' '), `p${blockKey}`)}
      </p>
    );
  }

  return (
    <div className="text-sm">
      {nodes}
      {streaming && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent-glow align-middle" />}
    </div>
  );
}
