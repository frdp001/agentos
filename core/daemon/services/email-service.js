'use strict';

/**
 * EmailService - outbound + inbound transport with graceful degradation.
 *
 * Transport preference:
 *   1. Composio (Gmail / Outlook connected accounts, REST v3)
 *   2. Resend REST API
 *   3. SendGrid REST API
 *   4. SMTP via nodemailer (optional dependency)
 *   5. dry-run (no network; everything is logged and accepted)
 *
 * Inbound polling uses Composio, IMAP via imapflow (optional dependency), or
 * dry-run. Every fetched message is run through `classifyText` before being
 * handed to the persistence/broadcast callback.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COMPOSIO_BASE = process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev/api/v3';
const HTTP_TIMEOUT_MS = 15000;

const UNSUBSCRIBE_RE = /\b(unsubscribe|remove me|opt[- ]?out|stop emailing|take me off)\b/i;
const OBJECTION_RE =
  /\b(already (have|use|work with)|too expensive|no budget|not interested|not right now|bad timing|have a vendor|competitor)\b/i;
const INTEREST_RE =
  /\b(interested|sounds good|tell me more|send (me )?(pricing|details)|happy to chat|book a (call|demo)|schedule)\b/i;

/** Heuristic triage classifier; the Hermes engine can override this later. */
function classifyText(text = '') {
  if (UNSUBSCRIBE_RE.test(text)) return 'unsubscribe';
  if (OBJECTION_RE.test(text)) return 'objection';
  if (INTEREST_RE.test(text)) return 'interested';
  return 'interested';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EmailService {
  constructor({ log, dataRoot, config = {}, onInbound } = {}) {
    this.log = log || (() => {});
    this.dataRoot = dataRoot || path.join(process.env.HOME || '.', '.alaye-os', 'data');
    this.onInbound = onInbound || (() => {});
    this.config = { ...this._envConfig(), ...config };
  }

  _envConfig() {
    return {
      composioApiKey: process.env.COMPOSIO_API_KEY || '',
      composioUserId: process.env.COMPOSIO_USER_ID || 'alaye-os',
      gmailAccountId: process.env.COMPOSIO_GMAIL_ACCOUNT_ID || '',
      outlookAccountId: process.env.COMPOSIO_OUTLOOK_ACCOUNT_ID || '',
      resendApiKey: process.env.RESEND_API_KEY || '',
      sendgridApiKey: process.env.SENDGRID_API_KEY || '',
      smtp: {
        host: process.env.SMTP_HOST || '',
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
      },
      imap: {
        host: process.env.IMAP_HOST || '',
        port: Number(process.env.IMAP_PORT || 993),
        user: process.env.IMAP_USER || '',
        pass: process.env.IMAP_PASS || '',
      },
    };
  }

  configure(config = {}) {
    this.config = { ...this.config, ...config };
    return this.status();
  }

  /** First configured transport wins. */
  resolveTransport() {
    const c = this.config;
    if (c.composioApiKey) return 'composio';
    if (c.resendApiKey) return 'resend';
    if (c.sendgridApiKey) return 'sendgrid';
    if (c.smtp?.host) return 'smtp';
    return 'dry-run';
  }

  status() {
    return {
      transport: this.resolveTransport(),
      composio: {
        configured: Boolean(this.config.composioApiKey),
        gmail: Boolean(this.config.gmailAccountId),
        outlook: Boolean(this.config.outlookAccountId),
      },
      resend: Boolean(this.config.resendApiKey),
      sendgrid: Boolean(this.config.sendgridApiKey),
      smtp: Boolean(this.config.smtp?.host),
      imap: Boolean(this.config.imap?.host),
    };
  }

  // --- outbound ---------------------------------------------------------
  async sendEmail({ to, subject, body, persona }) {
    const from = persona?.fromEmail || this.config.fromEmail;
    const fromName = persona?.fromName || this.config.fromName;
    const payload = { to, subject, body, from, fromName };
    const order = this._sendOrder();

    const errors = [];
    for (const transport of order) {
      try {
        const result = await this._sendVia(transport, payload);
        this.log('info', `email sent via ${transport}`, { to, id: result.id });
        return { ok: true, transport, ...result };
      } catch (err) {
        errors.push({ transport, error: err.message });
        this.log('warn', `email via ${transport} failed`, { err: err.message });
      }
    }
    return { ok: false, transport: 'none', errors };
  }

  _sendOrder() {
    const primary = this.resolveTransport();
    const all = ['composio', 'resend', 'sendgrid', 'smtp', 'dry-run'];
    return [primary, ...all.filter((t) => t !== primary)];
  }

  async _sendVia(transport, payload) {
    switch (transport) {
      case 'composio':
        return this._sendComposio(payload);
      case 'resend':
        return this._sendResend(payload);
      case 'sendgrid':
        return this._sendSendgrid(payload);
      case 'smtp':
        return this._sendSmtp(payload);
      default:
        return this._sendDryRun(payload);
    }
  }

  async _sendComposio({ to, subject, body, from }) {
    const accountId = this.config.gmailAccountId || this.config.outlookAccountId;
    if (!this.config.composioApiKey || !accountId) throw new Error('composio not configured');
    const action = this.config.outlookAccountId ? 'OUTLOOK_SEND_EMAIL' : 'GMAIL_SEND_EMAIL';
    const result = await this._httpJson(`${COMPOSIO_BASE}/actions/${action}/execute`, {
      method: 'POST',
      headers: this._composioHeaders(),
      body: {
        connected_account_id: accountId,
        user_id: this.config.composioUserId,
        input: { recipient_email: to, subject, body, sender: from },
      },
    });
    return { id: result?.data?.id || result?.id || crypto.randomUUID() };
  }

  async _sendResend({ to, subject, body, from }) {
    if (!this.config.resendApiKey) throw new Error('resend not configured');
    const result = await this._httpJson('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: { from: from || 'onboarding@resend.dev', to, subject, text: body },
    });
    return { id: result?.id || crypto.randomUUID() };
  }

  async _sendSendgrid({ to, subject, body, from }) {
    if (!this.config.sendgridApiKey) throw new Error('sendgrid not configured');
    const result = await this._httpJson('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.sendgridApiKey}`,
        'content-type': 'application/json',
      },
      body: {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from || this.config.fromEmail || 'noreply@example.com' },
        subject,
        content: [{ type: 'text/plain', value: body }],
      },
    });
    return { id: result?.['x-message-id'] || crypto.randomUUID() };
  }

  async _sendSmtp({ to, subject, body, from, fromName }) {
    const nodemailer = this._optional('nodemailer');
    if (!nodemailer) throw new Error('nodemailer not installed');
    const smtp = this.config.smtp;
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    const info = await transporter.sendMail({
      from: fromName ? `"${fromName}" <${from}>` : from,
      to,
      subject,
      text: body,
    });
    return { id: info.messageId };
  }

  async _sendDryRun({ to, subject }) {
    this.log('info', 'DRY-RUN send', { to, subject });
    return { id: `dry-${crypto.randomUUID()}` };
  }

  // --- inbound ----------------------------------------------------------
  async fetchInbound() {
    const transport = this.resolveTransport();
    try {
      if (transport === 'composio') return await this._fetchComposio();
      if (this.config.imap?.host) return await this._fetchImap();
    } catch (err) {
      this.log('warn', 'inbound fetch failed', { transport, err: err.message });
    }
    return [];
  }

  async _fetchComposio() {
    const accountId = this.config.gmailAccountId || this.config.outlookAccountId;
    if (!accountId) return [];
    const action = this.config.outlookAccountId ? 'OUTLOOK_FETCH_EMAILS' : 'GMAIL_FETCH_EMAILS';
    const result = await this._httpJson(`${COMPOSIO_BASE}/actions/${action}/execute`, {
      method: 'POST',
      headers: this._composioHeaders(),
      body: {
        connected_account_id: accountId,
        user_id: this.config.composioUserId,
        input: { max_results: 20, query: 'is:unread' },
      },
    });
    const messages = result?.data?.messages || result?.data?.emails || [];
    return messages.map((m) => this._normaliseMessage(m));
  }

  async _fetchImap() {
    const imapflow = this._optional('imapflow');
    if (!imapflow) throw new Error('imapflow not installed');
    const imap = this.config.imap;
    const client = new imapflow.ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: true,
      auth: { user: imap.user, pass: imap.pass },
    });
    const out = [];
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch({ seen: false }, { envelope: true, source: true })) {
        out.push(
          this._normaliseMessage({
            id: String(msg.uid),
            from: msg.envelope?.from?.[0]?.address,
            subject: msg.envelope?.subject,
            body: msg.source ? msg.source.toString('utf8').slice(0, 4000) : '',
            date: msg.envelope?.date,
          })
        );
      }
    } finally {
      lock.release();
      await client.logout();
    }
    return out;
  }

  _normaliseMessage(m) {
    return {
      id: m.id || m.messageId || crypto.randomUUID(),
      from: m.from || m.sender || '',
      subject: m.subject || m.snippet || '(no subject)',
      body: m.body || m.text || m.snippet || '',
      receivedAt: m.date ? new Date(m.date).getTime() : Date.now(),
    };
  }

  /**
   * Poll inbound, classify, and hand each new reply to the persistence /
   * broadcast callback. Returns a summary for the daemon cron log.
   */
  async pollInbound({ seen = new Set() } = {}) {
    const messages = await this.fetchInbound();
    const ingested = [];
    for (const msg of messages) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      const category = classifyText(`${msg.subject}\n${msg.body}`);
      const reply = {
        id: msg.id,
        from: msg.from,
        subject: msg.subject,
        body: msg.body,
        category,
        receivedAt: msg.receivedAt,
        source: this.resolveTransport(),
      };
      try {
        await this.onInbound(reply);
        ingested.push(reply);
      } catch (err) {
        this.log('error', 'inbound handler failed', { err: String(err) });
      }
    }
    return { fetched: messages.length, ingested };
  }

  // --- helpers ----------------------------------------------------------
  _composioHeaders() {
    return {
      'x-api-key': this.config.composioApiKey,
      'content-type': 'application/json',
    };
  }

  _optional(name) {
    try {
      return require(name);
    } catch {
      return null;
    }
  }

  async _httpJson(url, { method = 'GET', headers = {}, body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const json = text ? safeJson(text) : {};
      if (!res.ok) {
        throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Load non-secret transport config from ~/.alaye-os/data/email.json. */
  loadFileConfig() {
    const file = path.join(this.dataRoot, 'email.json');
    if (!fs.existsSync(file)) return this.config;
    try {
      this.config = { ...this.config, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      this.log('warn', 'invalid email.json', { err: String(err) });
    }
    return this.config;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

module.exports = { EmailService, classifyText };