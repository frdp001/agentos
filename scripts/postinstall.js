#!/usr/bin/env node
'use strict';

/**
 * Root postinstall. Keeps workspace bootstrapping side-effect free: it only
 * scaffolds the per-user data directory and copies the example config on a
 * first run. Never touches secrets.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataRoot = process.env.ALAYE_DATA_DIR || path.join(os.homedir(), '.alaye-os');
const dirs = ['data', 'logs', 'components'];

try {
  for (const dir of dirs) fs.mkdirSync(path.join(dataRoot, dir), { recursive: true });

  const example = path.join(__dirname, '..', 'config', 'alaye.example.json');
  const target = path.join(dataRoot, 'config.json');
  if (fs.existsSync(example) && !fs.existsSync(target)) {
    fs.copyFileSync(example, target);
  }
} catch (err) {
  // A read-only or sandboxed HOME should not fail the install.
  process.stderr.write(`alaye postinstall: ${err.message}\n`);
}
