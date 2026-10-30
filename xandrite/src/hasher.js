'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

/**
 * SHA-256 of a file, read as a stream in 1 MB pieces. Memory use stays small however large the file is.
 * Resolves to the lowercase hex digest. Rejects with an AbortError if the signal is aborted.
 */
function hashFile(filePath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error('Hashing was cancelled'), { name: 'AbortError' });
    if (signal && signal.aborted) return reject(abortError());

    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    const onAbort = () => stream.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => { cleanup(); reject(error); });
    stream.on('end', () => { cleanup(); resolve(hash.digest('hex')); });
  });
}

module.exports = { hashFile };
