'use strict';

const electronLog = require('electron-log');

electronLog.transports.file.level = 'info';
electronLog.transports.file.maxSize = 5 * 1024 * 1024;
electronLog.transports.console.level = process.env.ALAYE_DEV === '1' ? 'debug' : 'info';
electronLog.transports.file.fileName = 'alaye-desktop.log';

module.exports = electronLog.scope('desktop');
