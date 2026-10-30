'use strict';
const fs = require('node:fs');
const path = require('node:path');

/*
 * The app used to be called Model Library and kept its data (the library database, the thumbnails and the logs) in a
 * folder of that name. When the new data folder has no library yet but the old one does, the library is COPIED across,
 * once. The old folder is left alone, so nothing is lost and an older version of the app still works.
 */

const COPIED = ['thumbnails', 'logs'];   // folders; the database files are matched by name below
const isDatabaseFile = (name) => name === 'library.sqlite' || name === 'library.sqlite-wal' || name === 'library.sqlite-shm';

/** Returns 'copied', 'none' (no old library to bring across) or 'exists' (the new folder already has a library). */
function migrateLegacyData({ legacyDir, dataDir, log }) {
  try {
    if (path.resolve(legacyDir) === path.resolve(dataDir)) return 'none';
    if (!fs.existsSync(path.join(legacyDir, 'library.sqlite'))) return 'none';
    if (fs.existsSync(path.join(dataDir, 'library.sqlite'))) return 'exists';
    fs.mkdirSync(dataDir, { recursive: true });
    let files = 0;
    for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
      const from = path.join(legacyDir, entry.name);
      const to = path.join(dataDir, entry.name);
      if (entry.isFile() && isDatabaseFile(entry.name)) { fs.copyFileSync(from, to); files++; }
      else if (entry.isDirectory() && COPIED.includes(entry.name)) { fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false }); files++; }
    }
    if (log) log.info('data.migrated', { from: legacyDir, to: dataDir, items: files });
    return 'copied';
  } catch (error) {
    if (log) log.warn('data.migrate_failed', { from: legacyDir, to: dataDir, message: error.message });
    return 'none';
  }
}

module.exports = { migrateLegacyData };
