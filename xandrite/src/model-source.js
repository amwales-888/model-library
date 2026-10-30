'use strict';
const fs = require('node:fs/promises');
const { readArchiveEntry } = require('./archive-reader');

/**
 * The bytes of a model, wherever it lives: a loose file, or an entry inside an archive (.zip, .7z or .rar).
 * `source` is { path, container, entry }: container and entry are set for a model inside a zip.
 * Throws an error with code 'ENOENT' (file or zip gone) or 'ENTRY_NOT_FOUND' (the zip no longer holds the entry).
 */
function readModelBytes(source, { maxBytes } = {}) {
  if (source.container) return readArchiveEntry(source.container, source.entry, maxBytes ? { maxBytes } : undefined);
  return fs.readFile(source.path);
}

/** True when the error means "this model is no longer where the scan found it". */
const isGone = (error) => !!error && (error.code === 'ENOENT' || error.code === 'ENTRY_NOT_FOUND');

module.exports = { readModelBytes, isGone };
