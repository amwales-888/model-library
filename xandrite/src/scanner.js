'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const MODEL_EXTENSIONS = new Set(['.stl', '.3mf']);
// Archives whose contents are searched too: .zip is read with yauzl, .7z and .rar with the bundled 7-Zip.
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar']);
// Split archives. 7-Zip opens the whole set when given the first part, so only the first part is an archive here:
//   name.7z.001, name.7z.002 ...   name.rar.001 ...   name.part1.rar, name.part2.rar ...   name.rar, name.r00, name.r01 ...
const NUMBERED = /^(.*\.(?:7z|rar))\.(\d{3,})$/i;
const RAR_PART = /^(.*)\.part0*(\d+)\.rar$/i;
const OLD_RAR_VOLUME = /^(.*)\.[rs]\d\d$/i;

/** What a file name says about split archives: { first } for a set's first part, { later } for another part, or null. */
function splitRole(name) {
  let m = NUMBERED.exec(name);
  if (m) return Number(m[2]) === 1 ? { first: true, base: m[1], style: 'numbered' } : { later: true, base: m[1], number: Number(m[2]), style: 'numbered' };
  m = RAR_PART.exec(name);
  if (m) return Number(m[2]) === 1 ? { first: true, base: m[1], style: 'part' } : { later: true, base: m[1], number: Number(m[2]), style: 'part' };
  return null;
}

/**
 * The files that make up the split archive whose first part is `name`, found among the names in the same folder,
 * and what is wrong with the set (a missing part), if anything. A plain archive is a set of one.
 */
function archiveParts(name, names) {
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const role = splitRole(name);
  const found = [name];
  let problem = null;
  if (role && role.style === 'numbered') {
    const width = NUMBERED.exec(name)[2].length;
    for (let n = 2; ; n++) {
      const next = lower.get((role.base + '.' + String(n).padStart(width, '0')).toLowerCase());
      if (!next) break;
      found.push(next);
    }
    const highest = names.reduce((max, other) => { const m = NUMBERED.exec(other); return m && m[1].toLowerCase() === role.base.toLowerCase() ? Math.max(max, Number(m[2])) : max; }, 1);
    if (highest > found.length) problem = 'part ' + (found.length + 1) + ' of this split archive is missing';
  } else if (role && role.style === 'part') {
    const width = (RAR_PART.exec(name)[2] || '1').length;
    const parts = new Map();
    for (const other of names) { const m = RAR_PART.exec(other); if (m && m[1].toLowerCase() === role.base.toLowerCase()) parts.set(Number(m[2]), other); }
    for (let n = 2; parts.has(n); n++) found.push(parts.get(n));
    const highest = Math.max(...parts.keys());
    if (highest > found.length) problem = 'part ' + (found.length + 1) + ' of this split archive is missing';
    void width;
  } else if (/\.rar$/i.test(name)) {
    const base = name.slice(0, -4).toLowerCase();
    for (const other of names) { const m = OLD_RAR_VOLUME.exec(other); if (m && m[1].toLowerCase() === base) found.push(other); }
    found.sort((x, y) => (x === name ? -1 : y === name ? 1 : x.localeCompare(y)));
  }
  return { files: found, problem };
}

/** Is this file the (first) file to open for an archive? Later parts of a split set are not archives of their own. */
function isArchiveEntryPoint(name) {
  const role = splitRole(name);
  if (role) return !!role.first;
  return ARCHIVE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Walks a folder tree and yields every .stl and .3mf file as { path, size, mtimeMs }. With includeArchives it also yields
 * .zip, .7z and .rar files (with isArchive: true) so their contents can be read.
 * A problem reading a folder or file is yielded as { error, path } instead of stopping the walk.
 *
 * Hidden files and folders (names starting with ".") are skipped. That avoids .git folders, trash
 * folders and the "._name.stl" junk files macOS leaves on external drives. Symbolic links are not
 * followed, so a link that points back up the tree cannot cause an endless loop.
 */
async function* walk(root, { signal, includeArchives = false } = {}) {
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    if (signal && signal.aborted) return;
    const dir = queue[i];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      yield { error, path: dir, isDirectory: true };
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && includeArchives && splitRole(entry.name) && splitRole(entry.name).later) {
        // A later part whose first part is not in the folder: the set cannot be opened.
        const role = splitRole(entry.name);
        const hasFirst = entries.some((e) => { const r = splitRole(e.name); return e.isFile() && r && r.first && r.base.toLowerCase() === role.base.toLowerCase() && r.style === role.style; });
        if (!hasFirst) yield { error: new Error('the first part of this split archive is missing'), path: full, isDirectory: false };
      } else if (entry.isFile() && (MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || (includeArchives && isArchiveEntryPoint(entry.name)))) {
        try {
          const isArchive = !MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
          let size; let mtimeMs; let incomplete = null; let parts = 1;
          if (isArchive) {
            const set = archiveParts(entry.name, entries.filter((e) => e.isFile()).map((e) => e.name));
            const stats = await Promise.all(set.files.map((f) => fs.stat(path.join(dir, f))));
            size = stats.reduce((sum, st) => sum + st.size, 0);          // a changed or replaced part changes these,
            mtimeMs = Math.max(...stats.map((st) => st.mtimeMs));         // so the archive is looked at again
            incomplete = set.problem; parts = set.files.length;
          } else {
            const st = await fs.stat(full);
            size = st.size; mtimeMs = st.mtimeMs;
          }
          yield { path: full, size, mtimeMs, isArchive, ...(incomplete ? { incomplete } : {}), ...(parts > 1 ? { parts } : {}) };
        } catch (error) {
          yield { error, path: full, isDirectory: false };
        }
      }
    }
  }
}

module.exports = { walk, MODEL_EXTENSIONS, ARCHIVE_EXTENSIONS };
