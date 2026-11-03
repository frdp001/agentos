'use strict';

const path = require('node:path');
const logger = require('./logger');

/**
 * Bridges the Electron shell to the core OTA updater. Resolves the updater
 * from the workspace package in dev and from bundled core resources in prod.
 *
 * @param {{ appRoot: string, isDev: boolean }} opts
 */
async function runUpdateCheck({ appRoot, isDev }) {
  let updater;
  try {
    updater = require('@alaye/core-updater');
  } catch {
    updater = require(path.resolve(appRoot, '..', '..', 'core', 'updater', 'index.js'));
  }

  const result = await updater.checkForUpdates({ channel: isDev ? 'beta' : 'stable' });
  if (result.available) {
    logger.info(`OTA update available: ${result.version}`);
  } else {
    logger.debug('OTA: already current');
  }
  return result;
}

module.exports = { runUpdateCheck };
