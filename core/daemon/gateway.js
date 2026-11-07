'use strict';

/**
 * HermesGateway - adapter around the embedded Hermes Agent core.
 *
 * Phase 1 ships an in-memory working set so the shell is fully exercisable
 * before the real Hermes engine is linked in. Every method here maps 1:1 to a
 * Hermes capability (campaign execution, template rendering, reply sentiment,
 * provider routing) so swapping the backing store for the live engine is a
 * contained change.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const { PersonaService } = require('./services/persona-service');
const { MemoryService } = require('./services/memory-service');
const { EmailService } = require('./services/email-service');

const ENGINE_DIR = path.join(os.homedir(), '.alaye-os', 'engine');
const MEMORY_DIR = path.join(os.homedir(), '.alaye-os', 'memory');

/**
 * Root of the embedded Hermes install. Precedence:
 *   HERMES_HOME (explicit) > ALAYE_ENGINE_DIR (bundled resources/engine) >
 *   ~/.alaye-os/engine (installer-provisioned venv).
 */
function resolveHermesHome() {
  return process.env.HERMES_HOME || process.env.ALAYE_ENGINE_DIR || ENGINE_DIR;
}

/** Candidate CLI paths, covering installer venv and bundled layouts. */
function embeddedHermesCandidates() {
  const home = resolveHermesHome();
  return process.platform === 'win32'
    ? [
        path.join(home, 'venv', 'Scripts', 'hermes.exe'),
        path.join(home, 'hermes.exe'),
        path.join(home, 'hermes.cmd'),
        path.join(home, 'Scripts', 'hermes.exe'),
      ]
    : [
        path.join(home, 'venv', 'bin', 'hermes'),
        path.join(home, 'bin', 'hermes'),
        path.join(home, 'hermes'),
      ];
}

/** First existing CLI candidate, else the platform-default venv path. */
function embeddedHermesBinary() {
  const candidates = embeddedHermesCandidates();
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

/** Locate an executable on PATH without shelling out. */
function whichOnPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * Resolution order:
 *   1. explicit HERMES_BIN
 *   2. a global `hermes` on PATH
 *   3. the embedded venv binary provisioned by the installer
 */
function resolveHermesBinary() {
  if (process.env.HERMES_BIN && fs.existsSync(process.env.HERMES_BIN)) {
    return process.env.HERMES_BIN;
  }
  const global = whichOnPath('hermes');
  if (global) return global;
  const embedded = embeddedHermesBinary();
  if (fs.existsSync(embedded)) return embedded;
  return null;
}

class HermesGateway {
  constructor({ log, broadcast } = {}) {
    this.log = log || (() => {});
    this.broadcast = broadcast || (() => {});
    this.startedAt = Date.now();
    this.storageRoot = process.env.ALAYE_DATA_DIR || path.join(os.homedir(), '.alaye-os', 'data');
    this.dataRoot = this.storageRoot;
    this.hermesHome = resolveHermesHome();
    this.hermesBinary = resolveHermesBinary();
    this.hermesProcess = null;
    this.sessions = new Map();
    this.campaigns = new Map();
    this.templates = new Map();
    this.leads = new Map();
    this.replies = new Map();
    this.providers = new Map();
    this.seenInbound = new Set();

    // Phase 3 services: personas, Obsidian memory, email transport.
    this.personaService = new PersonaService({ dataRoot: this.dataRoot, log: this.log });
    this.memoryService = new MemoryService({
      root: process.env.ALAYE_MEMORY_DIR || MEMORY_DIR,
      log: this.log,
    });
    this.emailService = new EmailService({
      log: this.log,
      dataRoot: this.dataRoot,
      onInbound: (reply) => this._ingestReply(reply),
    });

    // Provider credentials for the embedded engine (Token Harbor or any
    // OpenAI-compatible endpoint), loaded from build config / env file.
    this.providerConfig = this._loadProviderConfig();

    this._loadOrSeed();
  }

  /**
   * Locate the editable provider config. Precedence:
   *   1. ALAYE_PROVIDER_CONFIG (injected by the Electron shell)
   *   2. ~/.alaye-os/data/default-provider.json (post-install editable copy)
   *   3. ALAYE_APP_ROOT/config/default-provider.json
   *   4. repo apps/desktop/config/default-provider.json (dev)
   */
  _loadProviderConfig() {
    const candidates = [
      process.env.ALAYE_PROVIDER_CONFIG,
      path.join(this.dataRoot, 'default-provider.json'),
      process.env.ALAYE_APP_ROOT
        ? path.join(process.env.ALAYE_APP_ROOT, 'config', 'default-provider.json')
        : null,
      path.resolve(__dirname, '..', '..', 'apps', 'desktop', 'config', 'default-provider.json'),
    ].filter(Boolean);

    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
          this.log('info', 'loaded default provider config', { file, provider: cfg.provider });
          return cfg;
        }
      } catch (err) {
        this.log('warn', 'invalid provider config', { file, err: String(err) });
      }
    }
    return {};
  }

  /** Parse a KEY=VALUE env file (comments and quotes tolerated). */
  _parseEnvFile(file) {
    try {
      if (!fs.existsSync(file)) return {};
      const out = {};
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Provider-related environment for the Hermes spawn: OPENAI_API_KEY,
   * OPENAI_BASE_URL and DEFAULT_MODEL. Placeholder values are ignored.
   */
  _providerEnv() {
    const cfg = this.providerConfig || {};
    const envFile = this._parseEnvFile(
      process.env.ALAYE_ENV_FILE || path.join(os.homedir(), '.alaye-os', 'alaye.env')
    );
    const pick = (value) => {
      const v = value == null ? '' : String(value);
      return v && !v.startsWith('YOUR_') ? v : undefined;
    };
    const out = {};
    const key = pick(cfg.openai_api_key || envFile.OPENAI_API_KEY);
    const base = pick(cfg.openai_base_url || envFile.OPENAI_BASE_URL);
    const model = pick(cfg.default_model || envFile.DEFAULT_MODEL);
    if (key) out.OPENAI_API_KEY = key;
    if (base) out.OPENAI_BASE_URL = base;
    if (model) out.DEFAULT_MODEL = model;
    if (cfg.provider) out.ALAYE_PROVIDER = cfg.provider;
    return out;
  }

  // --- local persistence (JSON store under ~/.alaye-os/data) -------------
  _storePath(name) {
    return path.join(this.dataRoot, `${name}.json`);
  }

  _loadCollection(name, map) {
    const file = this._storePath(name);
    if (!fs.existsSync(file)) return false;
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(rows)) for (const row of rows) if (row && row.id) map.set(row.id, row);
      return true;
    } catch (err) {
      this.log('warn', `failed to load ${name} store`, { err: String(err) });
      return false;
    }
  }

  /** Atomic write: render to a temp file, then rename over the live one. */
  _persist(name, map) {
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      const file = this._storePath(name);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...map.values()], null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log('error', `failed to persist ${name}`, { err: String(err) });
    }
  }

  _persistAll() {
    this._persist('templates', this.templates);
    this._persist('campaigns', this.campaigns);
    this._persist('replies', this.replies);
    this._persist('leads', this.leads);
  }

  _loadOrSeed() {
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
    } catch {
      /* read-only home: run in-memory */
    }
    this._loadCollection('templates', this.templates);
    const hadCampaigns = this._loadCollection('campaigns', this.campaigns);
    this._loadCollection('replies', this.replies);
    this._loadCollection('leads', this.leads);

    // First run: seed demo state and materialise the store on disk.
    if (!hadCampaigns) {
      this._seed();
      this._persistAll();
    }
  }

  /** Environment handed to every spawned Hermes process. */
  hermesEnv() {
    const binDir = this.hermesBinary ? path.dirname(this.hermesBinary) : '';
    const env = {
      ...process.env,
      HERMES_HOME: this.hermesHome,
      ...(binDir && { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` }),
    };
    // Inject OPENAI_API_KEY / OPENAI_BASE_URL / DEFAULT_MODEL when not already
    // present in the ambient environment.
    for (const [key, value] of Object.entries(this._providerEnv())) {
      if (!env[key]) env[key] = value;
    }
    return env;
  }

  /**
   * Build the actual (command, args) to execute. Handles two bundling shapes:
   *   - bundled embeddable Python: run `python/hermes_launcher.py`
   *   - a `.cmd`/`.bat` shim on Windows: run via the command interpreter
   *   - a native `hermes` executable: run directly
   */
  hermesInvocation(args = []) {
    const home = this.hermesHome;
    const pyCandidates =
      process.platform === 'win32'
        ? [path.join(home, 'python', 'python.exe')]
        : [
            path.join(home, 'python', 'bin', 'python3'),
            path.join(home, 'bin', 'python3'),
            path.join(home, 'python', 'python3'),
          ];
    const pyExe = pyCandidates.find((c) => fs.existsSync(c));
    const launcher = path.join(home, 'hermes_launcher.py');

    if (pyExe && fs.existsSync(launcher)) {
      return { command: pyExe, args: [launcher, ...args] };
    }
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.hermesBinary || '')) {
      const line = [this.hermesBinary, ...args].map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
      return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] };
    }
    return { command: this.hermesBinary, args };
  }

  /** True when the embedded Hermes gateway process is already up. */
  isGatewayRunning() {
    if (this.hermesProcess && this.hermesProcess.exitCode === null) return true;
    if (!this.hermesBinary) return false;
    // Probe the CLI; a non-zero/absent status command means "not running".
    const { command, args } = this.hermesInvocation(['gateway', 'status']);
    const probe = spawnSync(command, args, {
      cwd: this.hermesHome,
      env: this.hermesEnv(),
      timeout: 3000,
      stdio: 'ignore',
      windowsHide: true,
    });
    return probe.status === 0;
  }

  /**
   * Spawn `hermes gateway start` through the resolved binary. Resolves as soon
   * as the process is spawned so daemon startup is never blocked by the engine.
   */
  spawnGateway() {
    return new Promise((resolve, reject) => {
      this.log('info', 'starting embedded hermes gateway', { bin: this.hermesBinary });
      const { command, args } = this.hermesInvocation(['gateway', 'start']);
      const child = spawn(command, args, {
        cwd: this.hermesHome,
        env: this.hermesEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.hermesProcess = child;

      child.stdout?.on('data', (d) => this.log('debug', `[hermes] ${d.toString().trim()}`));
      child.stderr?.on('data', (d) => this.log('warn', `[hermes] ${d.toString().trim()}`));
      child.once('spawn', () => {
        this.log('info', 'embedded hermes gateway spawned', { pid: child.pid });
        resolve();
      });
      child.once('error', (err) => {
        this.log('error', 'failed to spawn hermes gateway', { err: String(err) });
        this.hermesProcess = null;
        reject(err);
      });
      child.once('exit', (code, signal) => {
        if (this.hermesProcess === child) this.hermesProcess = null;
        this.log('warn', 'embedded hermes gateway exited', { code, signal });
      });
    });
  }

  async start() {
    this.log('info', 'hermes gateway starting', {
      storage: this.storageRoot,
      home: this.hermesHome,
      bin: this.hermesBinary,
    });

    this.emailService.loadFileConfig();
    this.log('info', 'email transport resolved', this.emailService.status());

    this.hermesBinary = resolveHermesBinary();
    if (!this.hermesBinary) {
      this.log('warn', 'hermes CLI not found (checked PATH and embedded venv); running in scaffold mode');
      this.log('info', 'hermes gateway online (embedded scaffold)');
      return;
    }

    try {
      if (this.isGatewayRunning()) {
        this.log('info', 'embedded hermes gateway already running');
      } else {
        await this.spawnGateway();
      }
    } catch (err) {
      // A failed engine must not take down the daemon; the shell degrades.
      this.log('error', 'hermes gateway unavailable; continuing in scaffold mode', { err: String(err) });
    }
    this.log('info', 'hermes gateway online');
  }

  async stop() {
    const child = this.hermesProcess;
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    this.hermesProcess = null;
    this.log('info', 'hermes gateway stopped');
  }

  info() {
    return {
      engine: 'hermes',
      version: process.env.ALAYE_APP_VERSION || '0.1.0',
      uptimeMs: Date.now() - this.startedAt,
      storageRoot: this.storageRoot,
      hermesHome: this.hermesHome,
      hermesBinary: this.hermesBinary,
      hermesRunning: Boolean(this.hermesProcess && this.hermesProcess.exitCode === null),
      campaigns: this.campaigns.size,
      leads: this.leads.size,
      persona: this.personaService?.getActive()?.id ?? null,
      memoryNotes: this.memoryService?.listNotes().length ?? 0,
      emailTransport: this.emailService?.resolveTransport() ?? 'dry-run',
    };
  }

  // --- campaigns ---------------------------------------------------------
  campaignMetrics() {
    const campaigns = [...this.campaigns.values()];
    const sent = campaigns.reduce((n, c) => n + c.sent, 0);
    const replies = campaigns.reduce((n, c) => n + c.replies, 0);
    const interested = campaigns.reduce((n, c) => n + c.interested, 0);
    return {
      sent,
      replies,
      interested,
      responseRate: sent ? +(replies / sent).toFixed(4) : 0,
      positiveRate: replies ? +(interested / replies).toFixed(4) : 0,
      active: campaigns.filter((c) => c.status === 'active').length,
    };
  }

  listCampaigns() {
    return [...this.campaigns.values()];
  }

  createCampaign({ name, templateId }) {
    const id = crypto.randomUUID();
    const campaign = {
      id,
      name,
      templateId: templateId ?? null,
      status: 'draft',
      sent: 0,
      replies: 0,
      interested: 0,
      createdAt: Date.now(),
    };
    this.campaigns.set(id, campaign);
    this._persist('campaigns', this.campaigns);
    return campaign;
  }

  pauseCampaign(id) {
    return this._transition(id, 'paused');
  }

  resumeCampaign(id) {
    return this._transition(id, 'active');
  }

  _transition(id, status) {
    const c = this.campaigns.get(id);
    if (!c) throw new Error(`campaign not found: ${id}`);
    c.status = status;
    this._persist('campaigns', this.campaigns);
    return c;
  }

  // --- templates ---------------------------------------------------------
  listTemplates() {
    return [...this.templates.values()].map(({ id, name, updatedAt }) => ({ id, name, updatedAt }));
  }

  getTemplate(id) {
    const t = this.templates.get(id);
    if (!t) throw new Error(`template not found: ${id}`);
    return t;
  }

  saveTemplate({ id, name, body }) {
    const existing = this.templates.get(id);
    const template = {
      id,
      name: name ?? existing?.name ?? id,
      body,
      updatedAt: Date.now(),
    };
    this.templates.set(id, template);
    this._persist('templates', this.templates);
    return template;
  }

  // --- inbox / leads -----------------------------------------------------
  listReplies({ category } = {}) {
    const all = [...this.replies.values()];
    return category ? all.filter((r) => r.category === category) : all;
  }

  classifyReply({ id, category }) {
    const reply = this.replies.get(id);
    if (!reply) throw new Error(`reply not found: ${id}`);
    reply.category = category;
    reply.classifiedAt = Date.now();
    this._persist('replies', this.replies);
    return reply;
  }

  listLeads({ status } = {}) {
    const all = [...this.leads.values()];
    return status ? all.filter((l) => l.status === status) : all;
  }

  /**
   * Ingest a triaged inbound reply: persist to replies.json, write learnings
   * into the memory vault, bump live campaign metrics and broadcast an alert.
   */
  async _ingestReply(reply) {
    if (this.replies.has(reply.id)) return this.replies.get(reply.id);
    this.replies.set(reply.id, reply);
    this._persist('replies', this.replies);

    if (reply.category === 'objection') {
      this.memoryService.recordObjection({ label: reply.subject, detail: reply.body });
    }
    this.memoryService.recordLead({
      company: reply.company,
      email: reply.from,
      name: reply.name,
      status: reply.category,
      note: String(reply.body || '').slice(0, 500),
    });

    const active = [...this.campaigns.values()].find((c) => c.status === 'active');
    if (active) {
      active.replies = (active.replies || 0) + 1;
      if (reply.category === 'interested') active.interested = (active.interested || 0) + 1;
      this._persist('campaigns', this.campaigns);
    }

    // Push a desktop alert to every connected shell.
    this.broadcast('reply.new', reply);
    return reply;
  }

  // --- sender personas ---------------------------------------------------
  listPersonas() {
    return this.personaService.list();
  }

  getActivePersona() {
    return this.personaService.getActive();
  }

  setActivePersona(id) {
    const persona = this.personaService.setActive(id);
    this.broadcast('persona.changed', persona);
    return persona;
  }

  upsertPersona(input) {
    return this.personaService.upsert(input);
  }

  removePersona(id) {
    return this.personaService.remove(id);
  }

  // --- Obsidian memory vault --------------------------------------------
  memoryList({ category } = {}) {
    return this.memoryService.listNotes(category);
  }

  memorySearch({ query } = {}) {
    return this.memoryService.search(query);
  }

  memoryRead({ category, slug }) {
    return this.memoryService.readNote(category, slug);
  }

  memoryWrite({ category, slug, body, meta }) {
    return this.memoryService.writeNote(category, slug, body, meta);
  }

  /** Assemble the persona system prompt plus relevant vault context. */
  _systemPromptFor(message = '') {
    const persona = this.personaService?.getActive();
    const company = this._matchMemoryCompany(message);
    const memory = this.memoryService?.contextFor({ company });
    return [persona?.systemPrompt, memory ? `# Retrieved memory\n${memory}` : '']
      .filter(Boolean)
      .join('\n\n');
  }

  _matchMemoryCompany(message = '') {
    const text = message.toLowerCase();
    for (const note of this.memoryService?.listNotes('company_context') || []) {
      if (note.title && text.includes(note.title.toLowerCase())) return note.title;
    }
    return undefined;
  }

  // --- email transport ---------------------------------------------------
  emailStatus() {
    return this.emailService.status();
  }

  configureEmail(config) {
    return this.emailService.configure(config);
  }

  /** Send outreach as the active (or specified) persona. */
  async sendOutreach({ to, subject, message, personaId }) {
    const persona = personaId
      ? this.personaService.get(personaId)
      : this.personaService.getActive();
    const body = [message, '', persona.signature].filter(Boolean).join('\n');
    return this.emailService.sendEmail({
      to,
      subject,
      body,
      persona: this.personaService.resolveSender(persona.id),
    });
  }

  // --- providers ---------------------------------------------------------
  listProviders() {
    return [...this.providers.values()];
  }

  async testProvider({ provider }) {
    const p = this.providers.get(provider);
    if (!p) throw new Error(`provider not configured: ${provider}`);
    // Phase 2: issue a minimal completion/health probe against the endpoint.
    return { provider, reachable: true, checkedAt: Date.now() };
  }

  // --- agent chat (streamed) --------------------------------------------
  /**
   * Non-streaming convenience wrapper: aggregates the full reply.
   */
  async chat({ message, sessionId }) {
    const sid = sessionId || crypto.randomUUID();
    const systemPrompt = this._systemPromptFor(message);
    const reply = await this._runChat(message, sid, () => {}, systemPrompt);
    return { sessionId: sid, reply };
  }

  /**
   * Streaming variant. Emits `agent.token` notifications as chunks arrive and
   * resolves with the aggregated reply once the engine finishes.
   *
   * @param {{ message: string, sessionId?: string, streamId: string, emit: Function }} p
   */
  streamChat({ message, sessionId, streamId, emit }) {
    const sid = sessionId || crypto.randomUUID();
    const onToken = (token) => emit('agent.token', { streamId, sessionId: sid, token });
    const systemPrompt = this._systemPromptFor(message);
    return this._runChat(message, sid, onToken, systemPrompt).then((reply) => {
      emit('agent.done', { streamId, sessionId: sid });
      return { streamId, sessionId: sid, reply };
    });
  }

  /**
   * Run the engine, degrading to the scaffold reply if the binary is missing
   * or fails to spawn. If tokens already streamed, the error propagates
   * rather than duplicating output.
   */
  async _runChat(message, sessionId, onToken, systemPrompt = '') {
    if (!this.hermesBinary) return this._scaffoldChat(message, sessionId, onToken);
    let emitted = false;
    const wrapped = (token) => {
      emitted = true;
      onToken(token);
    };
    try {
      return await this._runHermesChat(message, sessionId, wrapped, systemPrompt);
    } catch (err) {
      if (emitted) throw err;
      this.log('warn', 'hermes chat failed; falling back to scaffold reply', { err: String(err) });
      return this._scaffoldChat(message, sessionId, onToken);
    }
  }

  /**
   * Execute the isolated Hermes binary (`hermes chat --json-stream`) and pump
   * stdout to `onToken`. Falls back to an in-process scaffold reply when the
   * engine is unavailable so the console stays usable.
   */
  _runHermesChat(message, sessionId, onToken, systemPrompt = '') {
    const bin = this.hermesBinary;
    if (!bin) return this._scaffoldChat(message, sessionId, onToken);

    return new Promise((resolve, reject) => {
      const chatArgs = ['chat', '--json-stream'];
      if (sessionId) chatArgs.push('--session', sessionId);
      if (systemPrompt) chatArgs.push('--system', systemPrompt);
      const { command, args } = this.hermesInvocation(chatArgs);
      const child = spawn(command, args, {
        cwd: this.hermesHome,
        env: this.hermesEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const parts = [];
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        reject(new Error('hermes chat timed out'));
      }, 120000);

      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        let nl;
        while ((nl = out.indexOf('\n')) !== -1) {
          const line = out.slice(0, nl);
          out = out.slice(nl + 1);
          const token = extractToken(line);
          if (token !== null) {
            parts.push(token);
            onToken(token);
          }
        }
      });
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (out.trim()) {
          const tail = extractToken(out);
          if (tail !== null) {
            parts.push(tail);
            onToken(tail);
          }
        }
        if (code !== 0 && parts.length === 0) {
          return reject(new Error(`hermes chat exited ${code}: ${err.trim()}`));
        }
        resolve(parts.join(''));
      });

      child.stdin.write(`${message}\n`);
      child.stdin.end();
    });
  }

  /** Deterministic offline reply, streamed in chunks to exercise the UI. */
  async _scaffoldChat(message, _sessionId, onToken) {
    const reply = this._craftReply(message);
    const chunks = reply.match(/[\s\S]{1,24}/g) || [reply];
    for (const chunk of chunks) {
      onToken(chunk);
      await delay(14);
    }
    return reply;
  }

  _craftReply(message = '') {
    const m = message.toLowerCase();
    if (m.includes('cold email') || m.includes('draft')) {
      return [
        '## Draft Cold Email',
        '',
        'Here is a first-pass sequence based on your template variables:',
        '',
        '```text',
        'Subject: {{first_name}}, quick idea for {{company}}',
        '',
        'Hi {{first_name}},',
        '',
        'Noticed {{company}} is investing in {{pain_point}}. We help teams',
        'automate that workflow end to end.',
        '',
        'Worth 15 minutes this week?',
        '```',
        '',
        'Inject `{{first_name}}`, `{{company}}` and `{{pain_point}}` at send time.',
      ].join('\n');
    }
    if (m.includes('objection')) {
      return [
        '## Inbox Objections',
        '',
        'Top objection clusters from recent replies:',
        '',
        '- **Vendor lock-in** — 38% · counter with migration path',
        '- **Budget** — 27% · offer a pilot tier',
        '- **Timing** — 19% · propose a nurture cadence',
        '',
        'I can draft rebuttals for any cluster on request.',
      ].join('\n');
    }
    if (m.includes('pause')) {
      return [
        '### Campaign Control',
        '',
        'I can pause a running loop. Confirm the target:',
        '',
        '1. `Q4 SaaS Founders` — active, 1,284 sent',
        '2. All campaigns',
        '',
        'Reply with the number and I will call `campaign.pause`.',
      ].join('\n');
    }
    return [
      '## Hermes Agent',
      '',
      `You said: _${message || '(empty)'}_`,
      '',
      'I can draft outreach, analyze replies, pause campaigns, or render',
      'templates. Try a quick action above, or ask something like:',
      '',
      '```text',
      'analyze inbox objections',
      '```',
      '',
      '_Running against the embedded Hermes engine._',
    ].join('\n');
  }

  // --- loops / updater ---------------------------------------------------
  cronLoops() {
    return [
      { name: 'inbox-poll', interval: '*/2 * * * *' },
      { name: 'send-queue', interval: '* * * * *' },
      { name: 'lead-scoring', interval: '0 3 * * *' },
    ];
  }

  async checkForUpdates() {
    return { available: false, version: process.env.ALAYE_APP_VERSION || '0.1.0' };
  }

  async applyUpdate() {
    throw new Error('update apply requires the packaged updater; not available in scaffold');
  }

  // --- background work hooks (called by cron in index.js) ----------------
  /**
   * Cron entrypoint: fetch inbound mail, classify, persist replies.json,
   * write memory learnings and broadcast desktop alerts.
   */
  async pollInbox() {
    const summary = await this.emailService.pollInbound({ seen: this.seenInbound });
    if (summary.ingested.length) {
      this.log('info', 'inbound replies ingested', { count: summary.ingested.length });
    } else {
      this.log('debug', 'polled inbound mailbox', { fetched: summary.fetched });
    }
    return summary;
  }

  async drainSendQueue() {
    this.log('debug', 'draining outreach send queue');
  }

  async recomputeLeadScores() {
    this.log('debug', 'recomputing lead scores');
  }

  // --- demo seed ---------------------------------------------------------
  _seed() {
    this.providers.set('openai', { id: 'openai', kind: 'remote', model: 'gpt-4o-mini', configured: false });
    this.providers.set('anthropic', { id: 'anthropic', kind: 'remote', model: 'claude-3-5-sonnet', configured: false });
    this.providers.set('ollama', { id: 'ollama', kind: 'local', endpoint: 'http://127.0.0.1:11434', configured: true });

    this.templates.set('tpl-intro', {
      id: 'tpl-intro',
      name: 'Cold Intro',
      body: 'Hi {{first_name}},\n\nNoticed {{company}} is working on {{pain_point}}...',
      updatedAt: Date.now(),
    });

    const seeded = this.createCampaign({ name: 'Q4 SaaS Founders', templateId: 'tpl-intro' });
    seeded.status = 'active';
    seeded.sent = 1284;
    seeded.replies = 137;
    seeded.interested = 41;

    const samples = [
      ['Interested', 'Sounds interesting, can you send pricing?', 'interested'],
      ['Unsubscribe', 'Please remove me from this list.', 'unsubscribe'],
      ['Objection', 'We already have a vendor for this.', 'objection'],
    ];
    for (const [subject, body, category] of samples) {
      const id = crypto.randomUUID();
      this.replies.set(id, { id, subject, body, category, receivedAt: Date.now() });
    }
  }
}

/**
 * Parse one stdout line from `hermes chat --json-stream` into a text token.
 * Accepts a few common envelope shapes; falls back to the raw line when the
 * engine emits plain text.
 */
function extractToken(line) {
  const s = String(line).trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const value = parsed.token ?? parsed.delta ?? parsed.content ?? parsed.text ?? parsed.message;
      return typeof value === 'string' ? value : null;
    }
  } catch {
    return s;
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  HermesGateway,
  resolveHermesBinary,
  resolveHermesHome,
  embeddedHermesBinary,
  extractToken,
};
