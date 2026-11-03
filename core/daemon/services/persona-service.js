'use strict';

/**
 * PersonaService - manages multiple Sender Personas.
 *
 * A persona bundles the identity the agent adopts when generating and sending
 * outreach: display name, from address, signature, tone directives, the LLM
 * provider binding and a derived system prompt.
 *
 * Persisted to ~/.alaye-os/data/personas.json (atomic write).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PERSONAS = [
  {
    id: 'founder',
    name: 'Alex Founder',
    role: 'Founder',
    email: 'alex@yourcompany.com',
    tone: 'warm, direct, low-jargon. Peer-to-peer, never salesy.',
    signature: '— Alex\nFounder, Your Company',
    provider: 'ollama',
  },
  {
    id: 'sdr',
    name: 'Sam SDR',
    role: 'SDR',
    email: 'sam@yourcompany.com',
    tone: 'concise, curious, benefit-led. One clear CTA per message.',
    signature: '— Sam\nSales Development, Your Company',
    provider: 'openai',
  },
  {
    id: 'ops',
    name: 'Olu Ops',
    role: 'Ops',
    email: 'olu@yourcompany.com',
    tone: 'precise, process-oriented, evidence-first.',
    signature: '— Olu\nOperations, Your Company',
    provider: 'anthropic',
  },
];

function systemPromptFor(persona) {
  return [
    `You are ${persona.name}, ${persona.role} at the company.`,
    `Write in the first person as ${persona.name}.`,
    `Tone: ${persona.tone || 'professional and concise'}.`,
    `Always sign off with:\n${persona.signature || `— ${persona.name}`}`,
    'Never invent facts about the prospect; use only provided memory context.',
    'Keep outreach under 120 words and end with exactly one clear call to action.',
  ].join('\n');
}

class PersonaService {
  constructor({ dataRoot, log } = {}) {
    this.dataRoot = dataRoot || path.join(process.env.HOME || '.', '.alaye-os', 'data');
    this.file = path.join(this.dataRoot, 'personas.json');
    this.log = log || (() => {});
    this.activeId = 'founder';
    this.personas = new Map();
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const p of data.personas || []) this.personas.set(p.id, p);
        if (data.activeId && this.personas.has(data.activeId)) this.activeId = data.activeId;
        return;
      }
    } catch (err) {
      this.log('warn', 'failed to load personas; reseeding', { err: String(err) });
    }
    for (const p of DEFAULT_PERSONAS) {
      this.personas.set(p.id, { ...p, createdAt: Date.now(), updatedAt: Date.now() });
    }
    this._persist();
  }

  _persist() {
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            activeId: this.activeId,
            personas: [...this.personas.values()].map((p) => ({ ...p, systemPrompt: systemPromptFor(p) })),
          },
          null,
          2
        )
      );
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log('error', 'failed to persist personas', { err: String(err) });
    }
  }

  list() {
    return [...this.personas.values()].map((p) => ({
      ...p,
      active: p.id === this.activeId,
      systemPrompt: systemPromptFor(p),
    }));
  }

  get(id) {
    const persona = this.personas.get(id);
    if (!persona) throw new Error(`persona not found: ${id}`);
    return { ...persona, active: persona.id === this.activeId, systemPrompt: systemPromptFor(persona) };
  }

  getActive() {
    return this.get(this.activeId);
  }

  setActive(id) {
    if (!this.personas.has(id)) throw new Error(`persona not found: ${id}`);
    this.activeId = id;
    this._persist();
    return this.getActive();
  }

  upsert(input) {
    const id = input.id || input.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `persona-${Date.now()}`;
    const existing = this.personas.get(id) || {};
    const persona = {
      ...existing,
      ...input,
      id,
      name: input.name ?? existing.name ?? id,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.personas.set(id, persona);
    this._persist();
    return this.get(id);
  }

  remove(id) {
    if (id === this.activeId) throw new Error('cannot remove the active persona');
    const removed = this.personas.delete(id);
    if (removed) this._persist();
    return { removed };
  }

  /** Sender identity + credentials binding used by the email service. */
  resolveSender(id) {
    const persona = id ? this.get(id) : this.getActive();
    return {
      personaId: persona.id,
      fromName: persona.name,
      fromEmail: persona.email,
      signature: persona.signature,
      provider: persona.provider,
    };
  }
}

module.exports = { PersonaService, DEFAULT_PERSONAS, systemPromptFor };