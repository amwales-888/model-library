'use strict';
// Copies the few three.js files the app uses into renderer/vendor/three, so the app (and its installer) carries
// them itself instead of depending on node_modules. Run `npm run vendor` after changing the three version.
const fs = require('node:fs');
const path = require('node:path');

const from = path.join(__dirname, '..', 'node_modules', 'three');
const to = path.join(__dirname, '..', 'renderer', 'vendor', 'three');
const files = [
  'LICENSE',
  'build/three.module.js',
  'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/loaders/STLLoader.js',
  'examples/jsm/loaders/3MFLoader.js',
  'examples/jsm/libs/fflate.module.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
];
fs.rmSync(to, { recursive: true, force: true });
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
console.log('Copied', files.length, 'files to', path.relative(process.cwd(), to));
