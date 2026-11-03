'use strict';

/**
 * MemoryService - Obsidian-style local "second brain".
 *
 * A plain Markdown vault under ~/.alaye-os/memory with subfolders:
 *   leads/            one note per prospect / company
 *   objections/       recurring objection patterns and rebuttals
 *   company_context/  firmographics, positioning, brand facts
 *
 * Files are human-editable and Obsidian-compatible (YAML frontmatter). The
 * agent reads relevant context before generating outreach and writes back
 * learnings during triage.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CATEGORIES = ['leads', 'objections', 'company_context'];

function slugify(value) {
  return String(value || 'untitled')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function frontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${String(value).replace(/\n/g, ' ')}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: text.slice(end + 4).replace(/^\n/, '') };
}

class MemoryService {
  constructor({ root, log } = {}) {
    this.root = root || process.env.ALAYE_MEMORY_DIR || path.join(os.homedir(), '.alaye-os', 'memory');
    this.log = log || (() => {});
    this.ensureVault();
  }

  ensureVault() {
    try {
      for (const category of CATEGORIES) {
        fs.mkdirSync(path.join(this.root, category), { recursive: true });
      }
    } catch (err) {
      this.log('warn', 'memory vault not writable', { err: String(err) });
    }
  }

  notePath(category, slug) {
    if (!CATEGORIES.includes(category)) throw new Error(`unknown memory category: ${category}`);
    return path.join(this.root, category, `${slugify(slug)}.md`);
  }

  writeNote(category, slug, content, meta = {}) {
    this.ensureVault();
    const file = this.notePath(category, slug);
    const payload =
      frontmatter({
        title: meta.title || slug,
        category,
        updatedAt: new Date().toISOString(),
        ...meta,
      }) + String(content || '').trimEnd() + '\n';
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
    return { category, slug: slugify(slug), path: file, title: meta.title || slug };
  }

  readNote(category, slug) {
    const file = this.notePath(category, slug);
    if (!fs.existsSync(file)) return null;
    const { meta, body } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
    return { category, slug: slugify(slug), meta, body, path: file };
  }

  listNotes(category) {
    const categories = category ? [category] : CATEGORIES;
    const out = [];
    for (const cat of categories) {
      const dir = path.join(this.root, cat);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const file = path.join(dir, name);
        const { meta } = stripFrontmatter(fs.readFileSync(file, 'utf8'));
        out.push({
          category: cat,
          slug: name.replace(/\.md$/, ''),
          title: meta.title || name.replace(/\.md$/, ''),
          updatedAt: meta.updatedAt || null,
        });
      }
    }
    return out;
  }

  search(query, { limit = 25 } = {}) {
    const needle = String(query || '').toLowerCase().trim();
    if (!needle) return [];
    const results = [];
    for (const note of this.listNotes()) {
      const file = this.notePath(note.category, note.slug);
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const matches = [];
      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(needle)) {
          matches.push({ line: idx + 1, text: line.trim().slice(0, 240) });
        }
      });
      if (matches.length) results.push({ ...note, score: matches.length, matches: matches.slice(0, 5) });
      if (results.length >= limit) break;
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Upsert a prospect note from an inbound reply. */
  recordLead({ company, email, name, status, note }) {
    const slug = slugify(company || email || name);
    const existing = this.readNote('leads', slug);
    const body = [
      `# ${company || name || email || 'Lead'}`,
      '',
      `- **Contact:** ${name || '—'}`,
      `- **Email:** ${email || '—'}`,
      `- **Status:** ${status || 'engaged'}`,
      '',
      note ? `## Notes\n\n${note}` : existing?.body || '',
    ].join('\n');
    return this.writeNote('leads', slug, body, { title: company || name || email || slug, tags: 'lead' });
  }

  /** Record an objection pattern and (optionally) a rebuttal. */
  recordObjection({ label, detail, rebuttal }) {
    const slug = slugify(label);
    const existing = this.readNote('objections', slug);
    const count = Number(existing?.meta?.count || 0) + 1;
    const body = [
      `# ${label}`,
      '',
      detail ? `> ${detail}` : '',
      '',
      `**Occurrences:** ${count}`,
      '',
      rebuttal ? `## Rebuttal\n\n${rebuttal}` : existing?.body || '',
    ].join('\n');
    return this.writeNote('objections', slug, body, { title: label, count, tags: 'objection' });
  }

  /** Ensure a company context note exists; create a stub when missing. */
  ensureCompanyContext(company, details = {}) {
    if (!company) return null;
    const slug = slugify(company);
    const existing = this.readNote('company_context', slug);
    if (existing) return existing;
    const body = [
      `# ${company}`,
      '',
      details.industry ? `- **Industry:** ${details.industry}` : '',
      details.website ? `- **Website:** ${details.website}` : '',
      details.notes ? `\n${details.notes}` : '',
      '',
      '_Auto-created by Alaye OS. Edit freely in Obsidian._',
    ]
      .filter(Boolean)
      .join('\n');
    return this.writeNote('company_context', slug, body, { title: company, tags: 'company' });
  }

  /**
   * Assemble relevant Markdown context for prompt injection. Keeps the budget
   * bounded so a large vault never blows the model context window.
   */
  contextFor({ company, painPoint, limit = 2400 } = {}) {
    const chunks = [];
    if (company) {
      const ctx = this.readNote('company_context', company);
      if (ctx) chunks.push(`## Company context: ${company}\n${ctx.body}`);
      const lead = this.readNote('leads', company);
      if (lead) chunks.push(`## Lead history: ${company}\n${lead.body}`);
    }
    if (painPoint) {
      for (const hit of this.search(painPoint, { limit: 3 })) {
        chunks.push(`## Related memory: ${hit.title} (${hit.category})\n${hit.matches.map((m) => m.text).join('\n')}`);
      }
    }
    if (!chunks.length) {
      for (const hit of this.listNotes('company_context').slice(0, 3)) {
        const note = this.readNote(hit.category, hit.slug);
        if (note) chunks.push(`## ${hit.title}\n${note.body}`);
      }
    }
    return chunks.join('\n\n').slice(0, limit);
  }
}

module.exports = { MemoryService, CATEGORIES, slugify };