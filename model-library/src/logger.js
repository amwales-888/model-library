'use strict';
const fs = require('node:fs');
const path = require('node:path');

/*
 * A plain-text log file, one event per line:
 *
 *   2026-10-28T16:49:12.345+00:00 INFO  hash path="/models/a.stl" sha256=ab12… size=1284 ms=3
 *
 * The time is the computer's local time with its offset. Values containing spaces or quotes are written as JSON
 * strings. Lines are collected and written a few times a second, and the file is rolled over when it reaches
 * maxBytes (model-library.log -> model-library.log.1 -> .2 ...), keeping `keep` old files, so it cannot fill a disk.
 */

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** "2026-10-28T16:49:12.345+00:00" in local time. */
function timestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' +
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3) +
    sign + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
}

function formatValue(value) {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = value instanceof Error ? value.message : String(value);
  return /^[\w.\-/:+@%]+$/.test(text) ? text : JSON.stringify(text);   // JSON also protects against line breaks
}

function formatLine(level, event, fields, date) {
  let line = timestamp(date) + ' ' + level.padEnd(5) + ' ' + event;
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    line += ' ' + key + '=' + formatValue(value);
  }
  return line;
}

/** A logger that does nothing. Used when no log file is wanted (and in most tests). */
const nullLogger = {
  path: null,
  info() {}, warn() {}, error() {},
  flush() {}, close() {},
};

function createLogger({ file, maxBytes = 10 * 1024 * 1024, keep = 5, flushMs = 250 }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  let pending = [];
  let timer = null;
  let broken = false;

  const rotate = () => {
    for (let i = keep - 1; i >= 1; i--) {
      try { fs.renameSync(file + '.' + i, file + '.' + (i + 1)); } catch { /* that old file does not exist */ }
    }
    try { fs.renameSync(file, file + '.1'); } catch { /* nothing to roll over */ }
    try { fs.rmSync(file + '.' + (keep + 1), { force: true }); } catch { /* ignore */ }
    size = 0;
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const lines = pending;
    pending = [];
    if (!lines.length || broken) return;
    try {
      let batch = [];
      let batchBytes = 0;
      const writeBatch = () => {
        if (!batch.length) return;
        fs.appendFileSync(file, batch.join(''));
        size += batchBytes;
        batch = []; batchBytes = 0;
      };
      for (const line of lines) {
        const text = line + '\n';
        const bytes = Buffer.byteLength(text);
        if (size + batchBytes > 0 && size + batchBytes + bytes > maxBytes) { writeBatch(); rotate(); }   // start a fresh file
        batch.push(text); batchBytes += bytes;
      }
      writeBatch();
    } catch (error) {
      broken = true;   // a log that cannot be written must never stop the app
      process.emitWarning('Could not write the log file: ' + error.message);
    }
  };

  const write = (level, event, fields) => {
    pending.push(formatLine(level, event, fields));
    if (!timer) { timer = setTimeout(flush, flushMs); if (timer.unref) timer.unref(); }
    if (pending.length >= 500) flush();
  };

  return {
    path: file,
    info: (event, fields) => write('INFO', event, fields),
    warn: (event, fields) => write('WARN', event, fields),
    error: (event, fields) => write('ERROR', event, fields),
    flush,
    close: flush,
  };
}

module.exports = { createLogger, nullLogger, formatLine, timestamp };
