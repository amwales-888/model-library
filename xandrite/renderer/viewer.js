// The thumbnail viewer window: load a model, orbit it, and save a thumbnail with its view settings embedded.
// Parsing, framing and PNG code live in ./lib/ and are shared with the background thumbnail renderer.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseModel, countTriangles, makeMaterial, disposeObject } from './lib/model-loader.js';
import { embedPngText, dataUrlToBytes, bytesToDataUrl } from './lib/png-text.js';
import { STATE_KEYWORD, THUMB_BG, CAMERA_FOV, addLights, orientAndCentre, placeDefaultCamera, placeStoredCamera, buildViewState } from './lib/view.js';

const $ = (id) => document.getElementById(id);
const viewerEl = $('viewer'), viewCanvas = $('view');
const statusEl = $('status');

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : '';
}

/* ---------- renderers, scene, cameras ---------- */
let renderer, thumbRenderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: viewCanvas, antialias: true, alpha: true });
  thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
} catch (e) {
  setStatus('This browser could not start WebGL, so models cannot be drawn.', true);
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
thumbRenderer.setPixelRatio(1);

const scene = new THREE.Scene();
addLights(scene);

const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 4 / 3, 0.1, 1000);
const thumbCam = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 1000);

// Everything we load goes inside `holder`, so we can rotate (Z-up) and re-centre it as one unit.
const holder = new THREE.Group();
scene.add(holder);

const controls = new OrbitControls(camera, viewCanvas);
controls.addEventListener('change', render);

// Re-render the thumbnail shortly after the user finishes orbiting, zooming or panning.
let thumbTimer = null;
function scheduleThumbnail() {
  clearNote();
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { if (hasModel) makeThumbnail(); }, 120);
}
controls.addEventListener('end', scheduleThumbnail);

function render() {
  renderer.render(scene, camera);
  if (hasModel) updateViewReadout();   // keep the View settings panel in step while orbiting, zooming or panning
}

function resize() {
  const w = viewerEl.clientWidth, h = viewerEl.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
  scheduleThumbnail();
}
new ResizeObserver(resize).observe(viewerEl);

/* ---------- current model state ---------- */
let radius = 1;        // half the diagonal of the centred model's bounding box
let hasModel = false;
let rawDims = null;    // bounding-box size in the file's own axes, before any rotation
let loadToken = 0;

function frame(cam, aspect) { placeDefaultCamera(cam, radius, aspect); }

function resetView() {
  frame(camera, viewerEl.clientWidth / Math.max(viewerEl.clientHeight, 1));
  controls.target.set(0, 0, 0);
  controls.update();
  render();
}

function applyOrientation() {
  radius = orientAndCentre(holder, $('zup').checked);
  resetView();
  makeThumbnail();
}

function showObject(obj) {
  while (holder.children.length) {
    const old = holder.children[0];
    holder.remove(old);
    disposeObject(old);
  }
  holder.rotation.set(0, 0, 0);
  holder.position.set(0, 0, 0);
  holder.add(obj);
  holder.updateMatrixWorld(true);
  rawDims = new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3());
  hasModel = true;
  applyOrientation();
}

/* ---------- thumbnail ---------- */
// The thumbnail uses the viewer's own camera position and orientation, so it shows what you set up.
// The viewer is square, so the thumbnail frames the same area. If a very narrow window makes the
// viewer taller than it is wide, the field of view is narrowed to keep the same pixel scale.
function syncThumbCamera() {
  const halfV = THREE.MathUtils.degToRad(camera.fov) / 2;
  thumbCam.position.copy(camera.position);
  thumbCam.quaternion.copy(camera.quaternion);
  thumbCam.near = camera.near;
  thumbCam.far = camera.far;
  thumbCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfV) * Math.min(1, camera.aspect)));
  thumbCam.aspect = 1;
  thumbCam.updateProjectionMatrix();
}

function getViewState(sizePx, fovDeg) {
  return buildViewState({
    position: camera.position,
    target: controls.target,
    fovDeg: fovDeg || camera.fov,
    zUp: $('zup').checked,
    sizePx: sizePx || parseInt($('tsize').value, 10),
    file: currentFile ? { name: currentFile.name, format: currentFile.format, sizeBytes: currentFile.sizeBytes, sha256: currentSha } : null,
  });
}

function updateViewReadout() {
  const s = getViewState(), c = s.camera;
  const f3 = (a) => a.map((n) => n.toFixed(3)).join(', ');
  $('v-pos').textContent = f3(c.position);
  $('v-target').textContent = f3(c.target);
  $('v-dist').textContent = c.distance.toFixed(3);
  $('v-az').textContent = c.azimuthDeg.toFixed(1) + '°';
  $('v-el').textContent = c.elevationDeg.toFixed(1) + '°';
  $('v-fov').textContent = c.fovDeg.toFixed(1) + '°';
  $('v-zup').textContent = s.zUp ? 'yes' : 'no';
  $('v-size').textContent = s.thumbnail.sizePx + ' × ' + s.thumbnail.sizePx + ' px';
  $('v-bg').textContent = s.thumbnail.background;
  $('v-ver').textContent = String(s.renderVersion);
}

let lastThumbFov = null;   // the field of view the thumbnail camera actually used
// PNG bytes of the current view at n x n pixels, with the view settings embedded.
function renderPngBytes(n) {
  thumbRenderer.setSize(n, n, false);
  thumbRenderer.setClearColor(THUMB_BG, 1);
  syncThumbCamera();
  thumbRenderer.render(scene, thumbCam);
  lastThumbFov = thumbCam.fov;
  const bytes = dataUrlToBytes(thumbRenderer.domElement.toDataURL('image/png'));
  try {
    return embedPngText(bytes, STATE_KEYWORD, JSON.stringify(getViewState(n, lastThumbFov), null, 2));
  } catch (e) {
    return bytes;   // still a valid PNG without the embedded settings
  }
}

function makeThumbnail() {
  if (!hasModel) return;
  const n = parseInt($('tsize').value, 10);
  thumbRenderer.setSize(n, n, false);
  thumbRenderer.setClearColor(THUMB_BG, 1);
  syncThumbCamera();
  thumbRenderer.render(scene, thumbCam);
  // A data: URL works in every browser and in sandboxed previews, where blob: URLs for images are sometimes blocked.
  const dataUrl = thumbRenderer.domElement.toDataURL('image/png');
  let href = dataUrl;
  try {
    href = bytesToDataUrl(embedPngText(dataUrlToBytes(dataUrl), STATE_KEYWORD, JSON.stringify(getViewState(), null, 2)), 'image/png');
  } catch (e) { /* the download still works without the embedded settings */ }
  updateViewReadout();
  const dl = $('download');
  dl.href = href;
  // Named after the file's SHA-256, so the thumbnail stays linked to the file even if it is renamed or moved.
  // Until the hash is ready (or for the sample shape) it falls back to the file's own name.
  dl.download = currentSha ? currentSha + '.png' : currentBaseName + '.thumb.png';
  dl.setAttribute('aria-disabled', 'false');
  updateUpdateButton();
}

/* ---------- replacing the library's thumbnail ---------- */
// Only available when the viewer was opened by the library app (see viewer-preload.js) and the file's hash is known.
const LIBRARY_THUMB_PX = 512;
const canUpdate = !!(window.viewerHost && window.viewerHost.replaceThumbnail);
let libraryRating = null;      // the rating stored in the library for this file (null = unrated)
let openedFromLibrary = false; // only files opened from the library can be rated
function showRating() {
  const select = $('rating');
  for (const id of ['rating-label', 'rating-cell']) $(id).hidden = !canUpdate;
  select.value = libraryRating ? String(libraryRating) : '';   // null (or a legacy 0) shows as Unrated
  select.disabled = !(canUpdate && openedFromLibrary && currentSha);
  select.title = openedFromLibrary ? '' : 'Open the file from the library to rate it.';
}
$('rating').addEventListener('change', async () => {
  const value = $('rating').value;
  const stars = value === '' ? null : Number(value);
  const note = $('rating-note');
  note.textContent = '';
  const result = await window.viewerHost.setRating(currentSha, stars);
  if (result.ok) { libraryRating = stars; note.textContent = 'Saved.'; }
  else { note.textContent = result.error; showRating(); }
});

let hasCustomView = false;   // the library holds a view set up by hand for this file
function updateUpdateButton() {
  $('update').hidden = !canUpdate;
  $('revert-row').hidden = !(canUpdate && hasCustomView);
  $('advanced').open = $('advanced').open || !canUpdate;   // without the library, the download is the only action
  if (canUpdate) $('update').disabled = !(hasModel && currentSha);
  showRating();
}
async function updateLibraryThumbnail() {
  if (!canUpdate || !currentSha) return;
  const button = $('update'), note = $('update-note');
  button.disabled = true;
  note.textContent = 'Updating…';
  try {
    const png = renderPngBytes(LIBRARY_THUMB_PX);
    makeThumbnail();   // put the preview/download back to the size chosen under Advanced
    // The view is stored too, so the thumbnail can be drawn the same way again later.
    const view = {
      position: camera.position.toArray(), target: controls.target.toArray(),
      fovDeg: lastThumbFov, zUp: $('zup').checked,
    };
    const result = await window.viewerHost.replaceThumbnail(currentSha, png, view);
    note.textContent = result.ok ? 'Thumbnail updated in the library.' : result.error;
    if (result.ok) { hasCustomView = true; updateUpdateButton(); }
  } catch (e) {
    note.textContent = 'Could not update: ' + (e && e.message ? e.message : e);
  }
  updateUpdateButton();
}
$('update').addEventListener('click', updateLibraryThumbnail);
$('revert').addEventListener('click', async () => {
  if (!canUpdate || !currentSha) return;
  $('revert').disabled = true;
  const result = await window.viewerHost.revertThumbnail(currentSha);
  $('update-note').textContent = result.ok ? 'Back to the automatic view. The thumbnail is being drawn again.' : result.error;
  if (result.ok) { hasCustomView = false; resetView(); makeThumbnail(); }
  $('revert').disabled = false;
  updateUpdateButton();
});

// Starts from the view saved for this file, if there is one.
function applyStoredView(view) {
  const fov = camera.fov;
  placeStoredCamera(camera, view, radius, camera.aspect);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  controls.target.set(...view.target);
  controls.update();
  render();
  makeThumbnail();
}
// A different file or a changed view invalidates the "updated" message.
function clearNote() { $('update-note').textContent = ''; }

/* ---------- info panel ---------- */
let currentBaseName = 'thumbnail';
let currentFile = null;   // { name, format, sizeBytes } for the loaded file, or null for the sample shape
let currentSha = null;    // SHA-256 of the loaded file once it has been calculated
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function setInfo(info) {
  $('i-name').textContent = info.name;
  $('i-fmt').textContent = info.format;
  $('i-size').textContent = info.size == null ? '-' : fmtBytes(info.size);
  $('i-tris').textContent = info.tris.toLocaleString();
  const d = rawDims;
  $('i-dims').textContent = d.x.toFixed(2) + ' × ' + d.y.toFixed(2) + ' × ' + d.z.toFixed(2) + ' (file units, usually mm)';
  $('i-sha').textContent = info.sha || '-';
}

async function sha256Hex(buf) {
  if (!(window.crypto && crypto.subtle)) return null;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- loading files ---------- */
async function handleFile(file, stored = null) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext !== 'stl' && ext !== '3mf') {
    setStatus('Choose an .stl or .3mf file.', true);
    return;
  }
  const token = ++loadToken;
  setStatus('Reading ' + file.name + '…');
  try {
    const buf = await file.arrayBuffer();
    const shaPromise = sha256Hex(buf);   // hash the original bytes before the loaders see them
    const { object: obj, triangles: tris } = parseModel(buf, ext);
    if (token !== loadToken) return;

    currentBaseName = file.name.replace(/\.[^.]+$/, '');
    currentFile = { name: file.name, format: ext.toUpperCase(), sizeBytes: file.size };
    currentSha = null;
    clearNote();
    hasCustomView = !!(stored && stored.custom);
    openedFromLibrary = !!stored;
    libraryRating = stored && stored.rating !== undefined ? stored.rating : null;
    $('rating-note').textContent = '';
    if (hasCustomView) $('zup').checked = stored.zUp;
    updateUpdateButton();
    showObject(obj);
    if (hasCustomView) applyStoredView(stored);
    setInfo({ name: file.name, format: ext.toUpperCase(), size: file.size, tris, sha: null });
    setStatus('Loaded ' + file.name + '.');
    const sha = await shaPromise;
    if (token === loadToken) {
      $('i-sha').textContent = sha || 'unavailable in this browser context';
      currentSha = sha;
      makeThumbnail();   // render again so the hash is included in the PNG's embedded settings
    }
  } catch (e) {
    if (token === loadToken) setStatus('Could not read that file: ' + (e && e.message ? e.message : e), true);
  }
}

/**
 * The Xandrite diamond: an eight-sided brilliant cut with its point down (Z is up), coloured like the logo, teal on one
 * side and amber on the other. It is shown until a model arrives.
 */
function makeDiamond() {
  const n = 8, girdleR = 10, tableR = 5.8, zTable = 6, zCulet = -11;
  const ring = (radius, z, turn) => Array.from({ length: n }, (_, k) => {
    const a = (k + turn) * 2 * Math.PI / n;
    return new THREE.Vector3(radius * Math.cos(a), radius * Math.sin(a), z);
  });
  const girdle = ring(girdleR, 0, 0);
  const table = ring(tableR, zTable, 0.5);   // turned half a step, so the crown gets kite and star facets
  const culet = new THREE.Vector3(0, 0, zCulet);
  const tableCentre = new THREE.Vector3(0, 0, zTable);
  const facets = [];   // [a, b, c, [left colour, right colour]]
  const TABLE = [0xd5dade, 0xd5dade], CROWN = [0x9aa3aa, 0xc2c9ce], PAVILION = [0x6b757c, 0x8a949b];   // greys, so it is calm when the real model replaces it
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    facets.push([girdle[k], girdle[k1], culet, PAVILION]);
    facets.push([table[k], table[k1], tableCentre, TABLE]);
    facets.push([girdle[k], girdle[k1], table[k], CROWN]);
    facets.push([table[k], table[k1], girdle[k1], CROWN]);
  }
  const inside = new THREE.Vector3(0, 0, -2);
  const positions = [];
  const colours = [];
  const colour = new THREE.Color();
  for (const [a, b, c, palette] of facets) {
    const centroid = a.clone().add(b).add(c).divideScalar(3);
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    const [p, q] = normal.dot(centroid.clone().sub(inside)) > 0 ? [b, c] : [c, b];   // wind every facet to face outwards
    colour.setHex(centroid.x < 0 ? palette[0] : palette[1]);
    for (const v of [a, p, q]) { positions.push(v.x, v.y, v.z); colours.push(colour.r, colour.g, colour.b); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geo.computeVertexNormals();   // not indexed, so every facet is flat
  return new THREE.Mesh(geo, makeMaterial(true));
}

function loadSample() {
  const token = ++loadToken;
  const mesh = makeDiamond();
  currentBaseName = 'xandrite-diamond';
  currentFile = null;
  currentSha = null;
  showObject(mesh);
  setInfo({ name: 'Xandrite diamond (sample, not a file)', format: '-', size: null, tris: countTriangles(mesh), sha: null });
  setStatus(window.viewerHost ? 'Opening the model…' : 'Showing the Xandrite diamond as a sample. Drop an STL or 3MF file to replace it.');
}

/* ---------- wiring ---------- */
$('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) handleFile(f);
  e.target.value = '';
});
$('pick').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('reset').addEventListener('click', () => { resetView(); makeThumbnail(); });
$('zup').addEventListener('change', () => { if (hasModel) applyOrientation(); });
$('tsize').addEventListener('change', makeThumbnail);
$('download').addEventListener('click', (e) => { if ($('download').getAttribute('aria-disabled') === 'true') e.preventDefault(); });

// Stop the browser from navigating away if a file is dropped outside the viewer.
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));
viewerEl.addEventListener('dragover', () => viewerEl.classList.add('dragging'));
viewerEl.addEventListener('dragleave', () => viewerEl.classList.remove('dragging'));
viewerEl.addEventListener('drop', (e) => {
  viewerEl.classList.remove('dragging');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

// Opened from the Xandrite window: the model is chosen there, so there is no file picker and the text says what this window is for.
if (window.viewerHost) {
  $('pick').parentElement.hidden = true;   // the row that held the Choose file button
  $('file').disabled = true;
  $('intro').textContent = 'Turn the model to the view that shows it best, then press Update to use that view as its thumbnail in your library.';
}

resize();
loadSample();

// Files opened from the library window arrive here (see viewer-preload.js).
if (window.viewerHost) window.viewerHost.onFile(({ name, bytes, view }) => handleFile(new File([bytes], name), view));
