'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { listLocations } = require('./db');
const { eachModelEntry } = require('./archive-reader');
const { nullLogger } = require('./logger');

/*
 * Things the right-click menu does with a selection. A selection arrives from the page as { query, blocks }: the query
 * that produced the list on screen, and the positions in it that are selected as [{ start, end }]. The rows are looked
 * up here, so a selection of 50,000 files never has to travel through the page.
 */

const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback);

/** Turns what the page sent into safe options for listLocations. */
function listOptionsFrom(query = {}, { limit, offset } = {}) {
  return {
    search: typeof query.search === 'string' ? query.search.slice(0, 200) : '',
    limit: clamp(limit !== undefined ? limit : query.limit, 1, 1000, 200),
    offset: clamp(offset !== undefined ? offset : query.offset, 0, 10_000_000, 0),
    dir: typeof query.dir === 'string' && query.dir ? query.dir : null,
    recursive: query.recursive !== false,
    includeMissing: query.includeMissing === true,
    sort: typeof query.sort === 'string' ? query.sort : 'name',
    sizeMin: finiteOrNull(query.sizeMin),
    sizeMax: finiteOrNull(query.sizeMax),
    since: finiteOrNull(query.since),
    before: finiteOrNull(query.before),
    ageBasis: query.ageBasis === 'added' ? 'added' : 'modified',
    rating: typeof query.rating === 'string' ? query.rating : 'any',
    direction: typeof query.direction === 'string' ? query.direction : null,
  };
}

const MAX_SELECTED = 200_000;

/** The blocks of a selection, checked: whole numbers, in order, and not an absurd amount. Returns null if it is not valid. */
function cleanBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 10_000) return null;
  const result = [];
  let total = 0;
  for (const b of blocks) {
    if (!b || !Number.isInteger(b.start) || !Number.isInteger(b.end) || b.start < 0 || b.end < b.start) return null;
    total += b.end - b.start + 1;
    result.push({ start: b.start, end: b.end });
  }
  return total <= MAX_SELECTED ? result : null;
}

/** Walks the selected rows in the order they are shown, a thousand at a time. */
function* selectedRows(db, selection) {
  const blocks = cleanBlocks(selection && selection.blocks);
  if (!blocks) return;
  for (const { start, end } of blocks) {
    for (let offset = start; offset <= end; offset += 1000) {
      const limit = Math.min(1000, end - offset + 1);
      const { rows } = listLocations(db, listOptionsFrom(selection.query, { limit, offset }));
      for (const row of rows) yield row;
      if (rows.length < limit) break;
    }
  }
}

/** The folder a model is "in" for the file manager: its own folder, or the folder that holds the archive it is in. */
const containingFolder = (row) => path.dirname(row.container || row.path);
/** The file to show in the file manager: the model, or the archive that holds it. */
const revealTarget = (row) => row.container || row.path;

/**
 * What the menu needs to know about a selection: how many, whether they all sit in one folder (Show in folder is only
 * offered then), and whether any has a hand-made view (Revert). Stops reading as soon as both are settled.
 */
function describeSelection(db, selection) {
  const info = { count: 0, sameFolder: true, folder: null, anyCustomView: false };
  const blocks = cleanBlocks(selection && selection.blocks);
  if (!blocks) return { ...info, count: 0, sameFolder: false };
  info.count = blocks.reduce((n, b) => n + (b.end - b.start + 1), 0);
  for (const row of selectedRows(db, selection)) {
    const folder = containingFolder(row);
    if (info.folder === null) info.folder = folder;
    else if (info.folder !== folder) info.sameFolder = false;
    if (row.customView) info.anyCustomView = true;
    if (!info.sameFolder && info.anyCustomView) break;
  }
  if (!info.sameFolder) info.folder = null;
  return info;
}

/* ---------- download: copy the selected models to a folder, extracting them from archives ---------- */

/** Picks a name that is not already used, adding " (2)", " (3)"... before the extension. `taken` holds lower-case names. */
function uniqueName(name, taken) {
  const lower = (n) => n.toLowerCase();
  if (!taken.has(lower(name))) { taken.add(lower(name)); return name; }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = base + ' (' + n + ')' + ext;
    if (!taken.has(lower(candidate))) { taken.add(lower(candidate)); return candidate; }
  }
}

/** A pass-through that hashes what flows by, so a copy can be checked against the hash the library holds. */
function hashing() {
  const hash = crypto.createHash('sha256');
  const stream = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); done(null, chunk); } });
  return { stream, digest: () => hash.digest('hex') };
}

/**
 * Writes `source` (a readable stream) to a NEW file in `dir` named like `wanted`. Never overwrites: if the name is taken
 * (even by a file that appeared a moment ago) a numbered name is used. Returns { target, sha256 }.
 */
async function writeNew(source, dir, wanted, taken, signal) {
  let name = uniqueName(wanted, taken);
  for (;;) {
    const target = path.join(dir, name);
    let out;
    try {
      out = fs.createWriteStream(target, { flags: 'wx' });
      await new Promise((resolve, reject) => { out.once('open', resolve); out.once('error', reject); });
    } catch (error) {
      if (error.code === 'EEXIST') { name = uniqueName(wanted, taken); continue; }
      source.destroy();
      throw error;
    }
    const h = hashing();
    try {
      await pipeline(source, h.stream, out, { signal });
      return { target, sha256: h.digest() };
    } catch (error) {
      await fsp.rm(target, { force: true }).catch(() => {});   // never leave half a file behind
      throw error;
    }
  }
}

class StopExtraction extends Error {}

/**
 * Copies the rows to `destination`. Loose files are copied; models inside archives are extracted straight into the
 * destination (nothing is unpacked anywhere else). Models from the same archive are read in one pass.
 *
 * Resolves to { copied, failed: [{ path, message }], changed, cancelled, total }. `changed` counts copies whose content
 * no longer matches the hash in the library (the file was edited after the last scan); they are kept.
 */
async function downloadRows(rows, destination, { signal, onProgress = () => {}, log = nullLogger } = {}) {
  const result = { copied: 0, failed: [], changed: 0, cancelled: false, total: rows.length };
  const taken = new Set((await fsp.readdir(destination)).map((n) => n.toLowerCase()));
  let done = 0;
  const step = (current) => onProgress({ done, total: rows.length, current });

  const finish = async (row, written, started) => {
    if (written.sha256 !== row.sha256) { result.changed++; log.warn('download.changed', { path: row.path, target: written.target, message: 'the content no longer matches the hash in the library' }); }
    if (Number.isFinite(row.modifiedMs)) { const when = new Date(row.modifiedMs); await fsp.utimes(written.target, when, when).catch(() => {}); }
    result.copied++;
    log.info('download.file', { path: row.path, target: written.target, sha256: written.sha256, size: row.size, ms: Date.now() - started });
  };
  const fail = (row, error) => {
    const message = error && error.message ? error.message : String(error);
    result.failed.push({ path: row.path, message });
    log.warn('download.fail', { path: row.path, message });
  };
  const cancelled = () => signal && signal.aborted;

  const loose = rows.filter((r) => !r.container);
  const byArchive = new Map();
  for (const r of rows.filter((x) => x.container)) {
    if (!byArchive.has(r.container)) byArchive.set(r.container, new Map());
    byArchive.get(r.container).set(r.entry, r);
  }

  for (const row of loose) {
    if (cancelled()) { result.cancelled = true; return result; }
    step(row.path);
    const started = Date.now();
    try {
      await finish(row, await writeNew(fs.createReadStream(row.path), destination, path.basename(row.path), taken, signal), started);
    } catch (error) {
      if (error.name === 'AbortError') { result.cancelled = true; return result; }
      fail(row, error);
    }
    done++;
  }

  for (const [archive, wanted] of byArchive) {
    if (cancelled()) { result.cancelled = true; return result; }
    const remaining = new Map(wanted);
    try {
      await eachModelEntry(archive, {
        signal,
        onProblem: ({ entryName, message }) => { const row = remaining.get(entryName); if (row) { remaining.delete(entryName); fail(row, new Error(message)); done++; step(row.path); } },
        onEntry: async (entry) => {
          const row = remaining.get(entry.entryName);
          if (!row) return;
          remaining.delete(entry.entryName);
          step(row.path);
          const started = Date.now();
          try {
            await finish(row, await writeNew(await entry.open(), destination, path.basename(row.path), taken, signal), started);
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            fail(row, error);
          }
          done++;
          if (remaining.size === 0) throw new StopExtraction();   // everything wanted from this archive is done
        },
      });
    } catch (error) {
      if (error.name === 'AbortError') { result.cancelled = true; return result; }
      if (!(error instanceof StopExtraction)) {
        for (const row of remaining.values()) { fail(row, new Error('could not read the archive: ' + error.message)); done++; }
        remaining.clear();
      }
    }
    for (const row of remaining.values()) { fail(row, new Error('it is no longer in the archive')); done++; }   // not found in the archive
  }
  step(null);
  return result;
}

module.exports = { listOptionsFrom, cleanBlocks, selectedRows, describeSelection, containingFolder, revealTarget, uniqueName, downloadRows };
