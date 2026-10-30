'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const yauzl = require('yauzl');
const { MODEL_EXTENSIONS, ARCHIVE_EXTENSIONS } = require('./scanner');

/*
 * Reading .stl and .3mf files that live inside .zip files, without unpacking anything to disk.
 * yauzl reads the zip's directory and then streams one entry at a time, so memory stays small however big the zip is.
 */

// Protection against zip bombs and absurd archives. A model entry over these limits is reported and skipped.
const LIMITS = {
  maxEntries: 200_000,                       // directory entries examined in one zip
  maxEntryBytes: 2 * 1024 * 1024 * 1024,     // one model, uncompressed
  maxRatio: 1000,                            // uncompressed : compressed. Real models are far below this.
  ratioMinBytes: 200 * 1024 * 1024,          // the ratio only matters for big entries
};

const abortError = () => Object.assign(new Error('The scan was cancelled'), { name: 'AbortError' });

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => (error ? reject(error) : resolve(zip)));
});
const openStream = (zip, entry) => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
});

/** The path a model inside a zip is shown and stored under: the zip's own path followed by the entry's folders. */
function virtualPath(zipPath, entryName) {
  return path.join(zipPath, ...entryName.split('/').filter(Boolean));
}

/** Why an entry should be ignored silently, or null if it could be a model. Hidden files and macOS junk are skipped. */
function classify(entryName) {
  if (entryName.endsWith('/')) return { skip: true };                                // a folder entry
  const segments = entryName.split('/').filter(Boolean);
  if (!segments.length || segments.some((s) => s === '.' || s === '..')) return { skip: true, unsafe: true };
  if (segments.some((s) => s.startsWith('.')) || segments[0] === '__MACOSX') return { skip: true };
  const ext = path.extname(segments[segments.length - 1]).toLowerCase();
  if (ARCHIVE_EXTENSIONS.has(ext)) return { skip: true, nested: true };
  if (!MODEL_EXTENSIONS.has(ext)) return { skip: true };
  return { skip: false, format: ext.slice(1) };
}

/**
 * Goes through the entries of one zip. For every model entry, `onEntry` is called, one at a time, with
 *   { entryName, format, size, mtimeMs, crc32, open }   where open() resolves to a readable stream of the content.
 * Problems with single entries (encrypted, too big...) go to `onProblem({ entryName, message })`.
 * Resolves to { nested } (how many zips inside the zip were skipped). Rejects if the zip itself cannot be read.
 */
async function eachModelEntry(zipPath, { onEntry, onProblem = () => {}, signal, limits = LIMITS }) {
  if (signal && signal.aborted) throw abortError();
  const zip = await openZip(zipPath);
  let nested = 0;
  try {
    await new Promise((resolve, reject) => {
      let examined = 0;
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          if (signal && signal.aborted) return reject(abortError());
          if (++examined > limits.maxEntries) return reject(new Error('the zip has too many entries (limit ' + limits.maxEntries.toLocaleString('en') + ')'));
          const kind = classify(entry.fileName);
          if (kind.nested) nested++;
          if (kind.unsafe) onProblem({ entryName: entry.fileName, message: 'unsafe file name in the zip' });
          if (!kind.skip) {
            if (entry.isEncrypted()) {
              onProblem({ entryName: entry.fileName, message: 'password-protected, so it cannot be read' });
            } else if (entry.uncompressedSize > limits.maxEntryBytes) {
              onProblem({ entryName: entry.fileName, message: 'too large to read from a zip (' + Math.round(entry.uncompressedSize / 1048576).toLocaleString('en') + ' MB)' });
            } else if (entry.uncompressedSize > limits.ratioMinBytes && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxRatio) {
              onProblem({ entryName: entry.fileName, message: 'skipped: it is compressed far more than a real model would be' });
            } else {
              await onEntry({
                entryName: entry.fileName,
                format: kind.format,
                size: entry.uncompressedSize,
                mtimeMs: entry.getLastModDate().getTime(),
                crc32: entry.crc32,
                open: () => openStream(zip, entry),
              });
            }
          }
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return { nested };
}

/** SHA-256 of a readable stream. Rejects with an AbortError if the signal is aborted. */
function hashStream(stream, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { stream.destroy(); return reject(abortError()); }
    const hash = crypto.createHash('sha256');
    const onAbort = () => stream.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => { cleanup(); reject(error); });
    stream.on('end', () => { cleanup(); resolve(hash.digest('hex')); });
  });
}

/**
 * Reads one entry of a zip into memory. Errors carry a code: 'ENOENT' when the zip is gone,
 * 'ENTRY_NOT_FOUND' when it no longer holds that entry, 'TOO_LARGE' when it is over maxBytes.
 */
async function readZipEntry(zipPath, entryName, { maxBytes = 512 * 1024 * 1024 } = {}) {
  const zip = await openZip(zipPath);   // yauzl reports a missing file with code ENOENT
  try {
    return await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => reject(Object.assign(new Error('That file is no longer in the zip.'), { code: 'ENTRY_NOT_FOUND' })));
      zip.on('entry', async (entry) => {
        if (entry.fileName !== entryName) return zip.readEntry();
        try {
          if (entry.uncompressedSize > maxBytes) throw Object.assign(new Error('The file is too large to read from the zip.'), { code: 'TOO_LARGE' });
          const stream = await openStream(zip, entry);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

module.exports = { eachModelEntry, hashStream, readZipEntry, virtualPath, classify, LIMITS };
