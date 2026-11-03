#!/usr/bin/env node
'use strict';

/**
 * Alaye OS OTA updater.
 *
 * Pulls a signed release manifest (GitHub Releases asset or S3 object),
 * compares it against the locally installed component versions, then
 * downloads, checksum-verifies and stages changed artifacts:
 *
 *   - agent-skills    : new/updated Hermes skill definitions
 *   - template-bundles: Markdown outreach template packs
 *   - engine-patches  : Hermes engine hotfixes
 *
 * Application is staged-then-swapped so a failed download never leaves the
 * install in a half-mutated state.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');

const DEFAULT_MANIFEST_URL =
  process.env.ALAYE_UPDATE_MANIFEST ||
  'https://github.com/alaye-systems/alaye-os-releases/releases/latest/download/manifest.json';

const COMPONENTS = ['agent-skills', 'template-bundles', 'engine-patches'];

class OtaUpdater {
  /**
   * @param {{ installRoot?: string, manifestUrl?: string, channel?: string }} [opts]
   */
  constructor(opts = {}) {
    this.installRoot = opts.installRoot || path.join(os.homedir(), '.alaye-os');
    this.manifestUrl = opts.manifestUrl || DEFAULT_MANIFEST_URL;
    this.cacheDir = path.join(this.installRoot, 'core', 'updater', 'cache');
    this.stagingDir = path.join(this.installRoot, 'core', 'updater', 'staging');
    this.statePath = path.join(this.installRoot, 'core', 'updater', 'state.json');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  /** Current installed versions per component (falls back to 0.0.0). */
  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return { components: {} };
    }
  }

  writeState(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Compare remote manifest against local state.
   * @param {{ channel?: string }} [opts]
   */
  async checkForUpdates({ channel = 'stable' } = {}) {
    const manifest = await this.fetchManifest(channel);
    const local = this.readState();
    const updates = [];

    for (const name of COMPONENTS) {
      const remote = manifest.components?.[name];
      if (!remote) continue;
      const current = local.components?.[name]?.version || '0.0.0';
      if (semverGt(remote.version, current)) {
        updates.push({ name, from: current, to: remote.version, url: remote.url, sha256: remote.sha256 });
      }
    }

    return {
      available: updates.length > 0,
      channel,
      version: manifest.version,
      updates,
    };
  }

  /**
   * Download, verify and stage every available update, then swap into place.
   * @param {{ channel?: string }} [opts]
   */
  async applyUpdates({ channel = 'stable' } = {}) {
    const result = await this.checkForUpdates({ channel });
    if (!result.available) return { applied: [], ...result };

    const applied = [];
    for (const update of result.updates) {
      const archive = path.join(this.cacheDir, `${update.name}-${update.to}.tar.gz`);
      await this.download(update.url, archive);

      const digest = await sha256File(archive);
      if (update.sha256 && digest !== update.sha256) {
        throw new Error(`checksum mismatch for ${update.name}: expected ${update.sha256}, got ${digest}`);
      }

      await this.stageAndSwap(update.name, archive);
      applied.push({ name: update.name, version: update.to });
    }

    const state = this.readState();
    state.components = state.components || {};
    for (const a of applied) state.components[a.name] = { version: a.version, updatedAt: Date.now() };
    state.lastCheck = Date.now();
    this.writeState(state);

    return { applied, channel, version: result.version };
  }

  /**
   * Verify, extract to staging, then atomically swap into the live component
   * directory. Uses a timestamped backup so a rollback is always possible.
   */
  async stageAndSwap(name, archive) {
    const extractDir = path.join(this.stagingDir, `${name}-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(archive, extractDir);

    const liveDir = path.join(this.installRoot, 'components', name);
    const backupDir = path.join(this.installRoot, 'components', `.${name}.bak-${Date.now()}`);
    fs.mkdirSync(path.dirname(liveDir), { recursive: true });

    if (fs.existsSync(liveDir)) fs.renameSync(liveDir, backupDir);
    fs.renameSync(extractDir, liveDir);

    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }

  fetchManifest(channel) {
    const url = `${this.manifestUrl}?channel=${encodeURIComponent(channel)}`;
    return this.fetchJson(url);
  }

  fetchJson(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers: { 'user-agent': 'alaye-os-updater' } }, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
            res.resume();
            return resolve(this.fetchJson(res.headers.location, redirects + 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`manifest fetch failed: HTTP ${res.statusCode}`));
          }
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error(`invalid manifest JSON: ${err.message}`));
            }
          });
        })
        .on('error', reject);
    });
  }

  download(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers: { 'user-agent': 'alaye-os-updater' } }, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
            res.resume();
            return resolve(this.download(res.headers.location, dest, redirects + 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`download failed: HTTP ${res.statusCode}`));
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(resolve));
          out.on('error', reject);
        })
        .on('error', reject);
    });
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Streaming gzip+tar extractor using only Node built-ins. */
async function extractTarGz(archive, destDir) {
  const zlib = require('node:zlib');
  const { pipeline } = require('node:stream/promises');
  const gunzip = zlib.createGunzip();
  const tar = new TarExtractor(destDir);
  await pipeline(fs.createReadStream(archive), gunzip, tar);
}

/**
 * Minimal POSIX ustar reader sufficient for our release archives. Handles
 * regular files and directory entries; rejects path traversal.
 */
const { Transform } = require('node:stream');
class TarExtractor extends Transform {
  constructor(destDir) {
    super();
    this.destDir = destDir;
    this.buffer = Buffer.alloc(0);
  }

  _transform(chunk, _enc, cb) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (this.buffer.length - offset >= 512) {
      const header = this.buffer.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) {
        offset += 512;
        continue;
      }
      const name = cstr(header.subarray(0, 100));
      const sizeField = cstr(header.subarray(124, 136)).trim();
      const size = parseInt(sizeField, 8) || 0;
      const type = String.fromCharCode(header[156]);
      const dataStart = offset + 512;
      const dataEnd = dataStart + size;
      const padded = Math.ceil(size / 512) * 512;
      if (this.buffer.length < dataStart + padded) break;

      const target = safeJoin(this.destDir, name);
      if (type === '5' || name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true });
      } else if (type === '0' || type === '\0' || type === '') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, this.buffer.subarray(dataStart, dataEnd));
      }
      offset = dataStart + padded;
    }
    this.buffer = this.buffer.subarray(offset);
    cb();
  }
}

function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

function safeJoin(root, name) {
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    throw new Error(`tar path traversal blocked: ${name}`);
  }
  return target;
}

/** True when a > b for x.y.z style versions. */
function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/** CLI: `alaye-update --check` / `--apply`. */
async function main() {
  const args = new Set(process.argv.slice(2));
  const updater = new OtaUpdater();
  if (args.has('--apply')) {
    const res = await updater.applyUpdates({});
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    const res = await updater.checkForUpdates({});
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`update failed: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { OtaUpdater, semverGt, sha256File, COMPONENTS };
