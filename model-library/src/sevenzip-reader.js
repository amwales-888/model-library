'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const childProcess = require('node:child_process');
const { Readable } = require('node:stream');
const { classify } = require('./zip-reader');

/*
 * Reading .stl and .3mf files inside .7z and .rar archives, without unpacking anything to disk.
 * The work is done by the 7-Zip command-line program that ships with the app (vendor/7zip). It is started with
 * arguments only (never through a shell) and its output is read as a stream.
 *
 * 7z and RAR archives are often "solid": the files are compressed as one block, so reading one file means
 * decompressing everything before it. To keep a scan fast, all the wanted entries are therefore extracted by ONE
 * 7-Zip process, in archive order, and the output (which is simply the files one after the other) is cut apart using
 * the sizes from the listing. Every entry is checked against its stored CRC-32, so a mix-up cannot go unnoticed.
 */

const LIMITS = {
  maxEntries: 200_000,
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  maxRatio: 1000,
  ratioMinBytes: 200 * 1024 * 1024,
};

const abortError = () => Object.assign(new Error('The scan was cancelled'), { name: 'AbortError' });
const isWindows = process.platform === 'win32';

/* ---------- finding the program ---------- */

let cachedBinary;
/** Path of the 7-Zip program, or null if this platform has none. MODEL_LIBRARY_7Z overrides the search. */
function binaryPath() {
  if (cachedBinary !== undefined) return cachedBinary;
  const exe = isWindows ? '7z.exe' : '7zz';
  const dir = isWindows ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux-' + process.arch;
  const candidates = [
    process.env.MODEL_LIBRARY_7Z,
    process.resourcesPath && path.join(process.resourcesPath, '7zip', exe),   // an installed app
    path.join(__dirname, '..', 'vendor', '7zip', dir, exe),                    // running from the source folder
  ].filter(Boolean);
  cachedBinary = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  if (cachedBinary && !isWindows) { try { fs.chmodSync(cachedBinary, 0o755); } catch { /* read-only install: it is probably already executable */ } }
  return cachedBinary;
}
const needBinary = () => {
  const bin = binaryPath();
  if (!bin) throw new Error('7-Zip is not available on this system, so .7z and .rar files cannot be read');
  return bin;
};

/* ---------- running it ---------- */

// -p with a made-up password means an encrypted archive fails with "wrong password" instead of asking on the keyboard.
const BASE_ARGS = ['-y', '-bd', '-bse2', '-bsp0', '-sccUTF-8', '-scsUTF-8', '-pmodellibrary-no-password'];

/** Picks the useful line out of 7-Zip's error output. */
function describeFailure(stderr, code) {
  const text = stderr.toString('utf8');
  if (/wrong password|encrypted archive|Enter password/i.test(text)) return 'password-protected, so it cannot be read';
  if (/Can not open the file as archive|Is not archive|Headers Error/i.test(text)) return 'not a valid archive, or damaged';
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /ERROR|Can not open|Data Error|CRC Failed|Unsupported/i.test(l));
  return (line || text.trim().split(/\r?\n/)[0] || 'exit code ' + code).replace(/^ERROR:\s*/i, '');
}

function runCollect(args, { signal, maxOutput = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const child = childProcess.spawn(needBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = []; const err = []; let size = 0; let failed = null;
    const onAbort = () => { failed = abortError(); child.kill(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { size += d.length; if (size > maxOutput) { failed = new Error('the archive listing is too large'); child.kill(); } else out.push(d); });
    child.stderr.on('data', (d) => { if (err.length < 64) err.push(d); });
    child.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (failed) return reject(failed);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err) });
    });
  });
}

/* ---------- listing ---------- */

/**
 * "2024-03-05 14:30:12.1234567" is how 7-Zip prints a date: the real (UTC) time shifted by the offset of the
 * computer's time zone as it is NOW, not as it was on that date. Undoing that exact shift gives back the true time.
 */
function parseTime(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?/.exec(text || '');
  if (!m) return null;
  const ms = m[7] ? Math.floor(Number('0.' + m[7]) * 1000) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms) + new Date().getTimezoneOffset() * 60000;
}

/** Runs `7zz l -slt` and returns { type, solid, entries: [{ raw, name, size, packed, mtimeMs, crc32, encrypted, directory }] }. */
async function listArchive(file, { signal, maxEntries = LIMITS.maxEntries } = {}) {
  const { code, stdout, stderr } = await runCollect(['l', '-slt', ...BASE_ARGS, '--', file], { signal });
  if (code !== 0 && code !== 1) throw new Error(describeFailure(stderr, code));   // 1 = warnings only
  const header = {};
  const entries = [];
  let current = null;
  let inEntries = false;
  const flush = () => {
    if (!current || current.Path === undefined) { current = null; return; }
    if (entries.length >= maxEntries) throw new Error('the archive has too many entries (limit ' + maxEntries.toLocaleString('en') + ')');
    const attrs = current.Attributes || '';
    const raw = current.Path;
    entries.push({
      raw,
      name: raw.split('\\').join('/'),
      directory: current.Folder === '+' || /^D/.test(attrs),
      size: Number(current.Size || 0),
      packed: Number(current['Packed Size'] || 0),
      mtimeMs: parseTime(current.Modified),
      crc32: current.CRC ? parseInt(current.CRC, 16) : null,
      encrypted: current.Encrypted === '+',
    });
    current = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '----------') { inEntries = true; current = {}; continue; }
    if (line === '') { if (inEntries) flush(); continue; }
    const at = line.indexOf(' = ');
    if (at < 0) continue;
    const key = line.slice(0, at); const value = line.slice(at + 3);
    if (!inEntries) { if (header[key] === undefined) header[key] = value; } else { if (!current) current = {}; current[key] = value; }
  }
  if (inEntries) flush();
  return { type: header.Type || '', solid: header.Solid === '+', physicalSize: Number(header['Physical Size'] || 0), entries };
}

/* ---------- extracting ---------- */

/** Writes a list of names for 7-Zip to read (names can be too many for the command line). */
async function writeNameList(names) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modellib-'));
  const file = path.join(dir, 'names.txt');
  await fsp.writeFile(file, names.join('\n') + '\n', 'utf8');
  return { file, remove: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

/**
 * One 7-Zip process that extracts a run of entries to its output, one after the other, and a way to take them
 * off that output in order. `entries` are the ones that may be wanted, in archive order.
 */
class Extractor {
  constructor(archive, entries, signal) {
    this.archive = archive; this.entries = entries; this.signal = signal;
    this.child = null; this.position = 0; this.pending = null;   // pending: the entry stream not yet fully read
    this.buffer = Buffer.alloc(0); this.iterator = null; this.stderr = []; this.names = null;
    this.closed = false;
  }

  async start(index) {
    this.stop();
    this.names = await writeNameList(this.entries.slice(index).map((e) => e.raw));
    const args = ['e', this.archive, '-so', '-bso0', '-spd', ...BASE_ARGS, '-i@' + this.names.file];
    this.child = childProcess.spawn(needBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', (d) => { if (this.stderr.length < 64) this.stderr.push(d); });
    this.child.on('error', () => {});
    this.exit = new Promise((resolve) => this.child.on('close', resolve));
    this.iterator = this.child.stdout[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.position = index; this.pending = null;
  }

  stop() {
    if (this.child) { this.child.stdout.destroy(); this.child.kill(); }
    if (this.names) this.names.remove();
    this.child = null; this.iterator = null; this.names = null; this.pending = null;
  }

  close() { this.closed = true; this.stop(); }

  async failure(base) {
    const code = this.child ? await Promise.race([this.exit, new Promise((r) => setTimeout(() => r(null), 2000))]) : null;
    return new Error(describeFailure(Buffer.concat(this.stderr), code) || base);
  }

  /** Yields the next `count` bytes of output as chunks. */
  async *take(count) {
    let left = count;
    while (left > 0) {
      if (this.buffer.length === 0) {
        const next = this.iterator ? await this.iterator.next() : { done: true };
        if (next.done) throw await this.failure('the archive ended before the file was complete');
        this.buffer = next.value;
      }
      const n = Math.min(left, this.buffer.length);
      yield this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      left -= n;
    }
  }

  /** A readable stream with the content of entry `index`. Entries must be asked for in archive order. */
  async open(index) {
    if (this.closed || (this.signal && this.signal.aborted)) throw abortError();
    if (!this.child || index < this.position || (this.pending && !this.pending.done)) await this.start(index);
    while (this.position < index) {                                  // entries that are not wanted: read and drop
      for await (const chunk of this.take(this.entries[this.position].size)) void chunk;   // eslint-disable-line no-unused-vars
      this.position++;
    }
    const entry = this.entries[index];
    const state = { done: false };
    this.pending = state;
    const self = this;
    const stream = Readable.from((async function* content() {
      let crc = 0;
      for await (const chunk of self.take(entry.size)) {
        crc = zlib.crc32(chunk, crc);
        yield chunk;
      }
      if (entry.crc32 !== null && crc >>> 0 !== entry.crc32 >>> 0) throw new Error('the file is damaged (checksum does not match)');
      state.done = true;
      self.position = index + 1;
    })());
    return stream;
  }
}

/* ---------- what the indexer and the viewer use ---------- */

/** Same contract as zip-reader.eachModelEntry. */
async function eachModelEntry(archivePath, { onEntry, onProblem = () => {}, signal, limits = LIMITS }) {
  if (signal && signal.aborted) throw abortError();
  const stat = await fsp.stat(archivePath);
  let listing;
  try {
    listing = await listArchive(archivePath, { signal, maxEntries: limits.maxEntries });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(error.message);
  }
  let nested = 0;
  const eligible = [];
  for (const e of listing.entries) {
    if (e.directory) continue;
    const kind = classify(e.name);
    if (kind.nested) nested++;
    if (kind.unsafe) onProblem({ entryName: e.name, message: 'unsafe file name in the archive' });
    if (kind.skip) continue;
    if (e.encrypted) onProblem({ entryName: e.name, message: 'password-protected, so it cannot be read' });
    else if (e.size > limits.maxEntryBytes) onProblem({ entryName: e.name, message: 'too large to read from an archive (' + Math.round(e.size / 1048576).toLocaleString('en') + ' MB)' });
    else if (e.packed > 0 && e.size > limits.ratioMinBytes && e.size / e.packed > limits.maxRatio) onProblem({ entryName: e.name, message: 'skipped: it is compressed far more than a real model would be' });
    else eligible.push({ ...e, format: kind.format });
  }
  const total = eligible.reduce((sum, e) => sum + e.size, 0);
  if (total > limits.ratioMinBytes && listing.physicalSize > 0 && total / listing.physicalSize > limits.maxRatio) {
    throw new Error('the archive is compressed far more than real models would be');
  }
  const extractor = new Extractor(archivePath, eligible, signal);
  try {
    for (let i = 0; i < eligible.length; i++) {
      const e = eligible[i];
      await onEntry({
        entryName: e.name,
        format: e.format,
        size: e.size,
        mtimeMs: e.mtimeMs === null ? stat.mtimeMs : e.mtimeMs,
        crc32: e.crc32,
        open: () => extractor.open(i),
      });
    }
  } finally {
    extractor.close();
  }
  return { nested };
}

/** Reads one entry into memory. Errors carry code 'ENOENT', 'ENTRY_NOT_FOUND' or 'TOO_LARGE', as for zips. */
async function readSevenZipEntry(archivePath, entryName, { maxBytes = 512 * 1024 * 1024 } = {}) {
  await fsp.stat(archivePath);                                       // rejects with ENOENT when the archive is gone
  const listing = await listArchive(archivePath);
  const entry = listing.entries.find((e) => !e.directory && e.name === entryName);
  if (!entry) throw Object.assign(new Error('That file is no longer in the archive.'), { code: 'ENTRY_NOT_FOUND' });
  if (entry.size > maxBytes) throw Object.assign(new Error('The file is too large to read from the archive.'), { code: 'TOO_LARGE' });
  if (entry.encrypted) throw new Error('The file is password-protected, so it cannot be read.');
  const extractor = new Extractor(archivePath, [entry], null);
  try {
    const chunks = [];
    const stream = await extractor.open(0);
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    extractor.close();
  }
}

module.exports = { eachModelEntry, readSevenZipEntry, listArchive, binaryPath, LIMITS };
