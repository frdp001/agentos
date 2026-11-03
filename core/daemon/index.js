#!/usr/bin/env node
'use strict';

/**
 * Alaye OS background daemon.
 *
 * Boots the embedded Hermes gateway, owns the persistent cron loops, and
 * serves a newline-delimited JSON-RPC endpoint over a unix domain socket
 * (POSIX) or named pipe (Windows) for the Electron shell.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const cron = require('node-cron');

const { HermesGateway } = require('./gateway');
const { createRouter } = require('./router');

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL = LOG_LEVELS[process.env.ALAYE_LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, msg, meta) {
  if (LOG_LEVELS[level] > LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta && { meta }) });
  process.stdout.write(`${line}\n`);
}

function resolveSocketPath() {
  if (process.env.ALAYE_SOCKET) return process.env.ALAYE_SOCKET;
  if (process.platform === 'win32') return '\\\\.\\pipe\\alaye-os-hermes';
  const dir = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `alaye-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'alaye-hermes.sock');
}

class Daemon {
  constructor() {
    this.socketPath = resolveSocketPath();
    this.server = null;
    this.sockets = new Set();
    this.gateway = new HermesGateway({ log, broadcast: (method, params) => this.broadcast(method, params) });
    this.router = createRouter({ gateway: this.gateway, log });
    this.loops = new Map();
    this.shuttingDown = false;
  }

  /** Push a JSON-RPC notification to every connected shell. */
  broadcast(method, params) {
    const frame = `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(frame);
    }
  }

  async start() {
    await this.gateway.start();
    this.startCronLoops();
    await this.listen();
    log('info', 'alaye daemon ready', { socket: this.socketPath, pid: process.pid });

    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('uncaughtException', (err) => log('error', 'uncaughtException', { err: String(err) }));
  }

  listen() {
    return new Promise((resolve, reject) => {
      // Clean up a stale socket file left by an unclean shutdown.
      if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
        try {
          fs.unlinkSync(this.socketPath);
        } catch (err) {
          log('warn', 'could not remove stale socket', { err: String(err) });
        }
      }

      this.server = net.createServer((socket) => this.onConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        if (process.platform !== 'win32') fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  onConnection(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    let buffer = '';
    // Server -> client push: JSON-RPC 2.0 notifications (no id) used for
    // streaming token deltas while the originating request is still open.
    const emit = (method, params) => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      }
    };

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const response = await this.dispatch(line, emit);
        if (response) socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.on('error', (err) => log('debug', 'socket error', { err: String(err) }));
  }

  async dispatch(raw, emit = () => {}) {
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
    }
    const id = req.id ?? null;

    // Notifications from the client need no response.
    if (id === null && !req.method) return null;

    try {
      const result = await this.router.handle(req.method, req.params ?? {}, { id, emit });
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const code = err.rpcCode ?? -32603;
      return { jsonrpc: '2.0', id, error: { code, message: err.message } };
    }
  }

  /** Persistent background loops the dashboard reports on. */
  startCronLoops() {
    // Poll the inbound mailbox for new replies every 2 minutes.
    this.schedule('inbox-poll', '*/2 * * * *', () => this.gateway.pollInbox());
    // Advance queued outreach sends every minute.
    this.schedule('send-queue', '* * * * *', () => this.gateway.drainSendQueue());
    // Nightly data rollup / lead scoring refresh.
    this.schedule('lead-scoring', '0 3 * * *', () => this.gateway.recomputeLeadScores());
  }

  schedule(name, expr, fn) {
    const task = cron.schedule(expr, async () => {
      this.loops.set(name, { name, expr, lastRun: Date.now(), running: true });
      try {
        await fn();
        myLogLastRun(this.loops, name, true);
      } catch (err) {
        log('error', `cron loop failed: ${name}`, { err: String(err) });
        myLogLastRun(this.loops, name, false);
      }
    });
    this.loops.set(name, { name, expr, lastRun: null, ok: null });
    task.start();
    this.loops.get(name).task = task;
  }

  async shutdown(signal) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log('info', 'shutting down', { signal });
    for (const loop of this.loops.values()) loop.task?.stop();
    await this.gateway.stop();
    await new Promise((resolve) => this.server?.close(resolve));
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        /* best effort */
      }
    }
    process.exit(0);
  }
}

function myLogLastRun(loops, name, ok) {
  const entry = loops.get(name);
  if (entry) {
    entry.lastRun = Date.now();
    entry.ok = ok;
    entry.running = false;
  }
}

const daemon = new Daemon();
daemon.start().catch((err) => {
  log('error', 'daemon failed to start', { err: String(err) });
  process.exit(1);
});

module.exports = { Daemon };
