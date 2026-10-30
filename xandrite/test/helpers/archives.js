'use strict';
// Makes .7z and .rar files for tests. .7z archives are made with the bundled 7-Zip. No RAR creator is available (RAR
// is a closed format), so a small RAR 5 writer builds archives that store files without compression. They are real
// RAR 5 files: 7-Zip and WinRAR both read them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { binaryPath } = require('../../src/sevenzip-reader');

const sevenZipAvailable = () => {
  const bin = binaryPath();
  if (!bin) return false;
  const r = spawnSync(bin, ['i'], { stdio: 'ignore' });
  return r.status === 0;
};

/** Creates a .7z at `target` from { name: content }. options: { solid, password, encryptHeaders, mtimes: { name: Date }, volume: '2k' (split into parts of that size) } */
function write7z(target, files, { solid = true, password, encryptHeaders = false, mtimes = {}, volume } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-7z-src-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      if (mtimes[name]) fs.utimesSync(full, mtimes[name], mtimes[name]);
    }
    for (const old of fs.existsSync(path.dirname(target)) ? fs.readdirSync(path.dirname(target)) : []) {
      if (old === path.basename(target) || old.startsWith(path.basename(target) + '.')) fs.rmSync(path.join(path.dirname(target), old), { force: true });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const args = ['a', '-bd', solid ? '-ms=on' : '-ms=off'];
    if (password) args.push('-p' + password, ...(encryptHeaders ? ['-mhe=on'] : []));
    if (volume) args.push('-v' + volume);
    args.push(target, '.');
    const r = spawnSync(binaryPath(), args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('7-Zip could not make the test archive: ' + r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return target;
}

const vint = (n) => {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

function block(type, flags, fields, dataSize) {
  const parts = [vint(type), vint(flags | (dataSize !== undefined ? 0x2 : 0))];
  if (dataSize !== undefined) parts.push(vint(dataSize));
  parts.push(...fields);
  const body = Buffer.concat(parts);
  const size = vint(body.length);
  const crc = u32(zlib.crc32(Buffer.concat([size, body])));
  return Buffer.concat([crc, size, body]);
}

/** Creates a RAR 5 file at `target` from { name: content }, storing every file uncompressed. */
function writeRar5(target, files, { mtime = new Date('2024-03-05T14:30:12Z') } = {}) {
  const chunks = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])];
  chunks.push(block(1, 0, [vint(0)]));                                   // main header, no flags
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBytes = Buffer.from(name, 'utf8');
    const fields = [
      vint(0x2 | 0x4),                                                   // has mtime, has CRC-32
      vint(data.length),                                                 // unpacked size
      vint(0x20),                                                        // attributes
      u32(Math.floor(mtime.getTime() / 1000)),
      u32(zlib.crc32(data)),
      vint(0),                                                           // method 0 = stored
      vint(1),                                                           // host OS: unix
      vint(nameBytes.length), nameBytes,
    ];
    chunks.push(block(2, 0, fields, data.length), data);
  }
  chunks.push(block(5, 0, [vint(0)]));                                   // end of archive
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat(chunks));
  return target;
}

module.exports = { sevenZipAvailable, write7z, writeRar5 };
