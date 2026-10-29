// Runs in a hidden window. For each job it parses the model, renders the default view into a 512 px PNG,
// stores the view settings inside the PNG, and sends the bytes back. It uses the same shared code as the
// viewer, so an automatic thumbnail looks exactly like the viewer's default view of the same file.
import * as THREE from 'three';
import { parseModel, disposeObject } from './lib/model-loader.js';
import { embedPngText, dataUrlToBytes } from './lib/png-text.js';
import { STATE_KEYWORD, THUMB_BG, CAMERA_FOV, addLights, orientAndCentre, placeDefaultCamera, placeStoredCamera, buildViewState } from './lib/view.js';

const SIZE = 512;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
} catch (error) {
  window.thumbs.fatal('WebGL could not start in the thumbnail renderer: ' + error.message);
  throw error;
}
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE, false);
renderer.setClearColor(THUMB_BG, 1);

const scene = new THREE.Scene();
addLights(scene);
const holder = new THREE.Group();
scene.add(holder);
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 1000);
const ORIGIN = new THREE.Vector3(0, 0, 0);

function renderJob(job) {
  const { object } = parseModel(job.bytes, job.ext);
  holder.add(object);
  try {
    // A view the person set up by hand is used when there is one; otherwise the automatic default view.
    const view = job.view || null;
    const radius = orientAndCentre(holder, view ? view.zUp : true);
    if (view) placeStoredCamera(camera, view, radius, 1);
    else { camera.fov = CAMERA_FOV; placeDefaultCamera(camera, radius, 1); }
    renderer.render(scene, camera);
    const target = view ? new THREE.Vector3(...view.target) : ORIGIN;
    const state = buildViewState({
      position: camera.position,
      target,
      fovDeg: camera.fov,
      zUp: view ? view.zUp : true,
      sizePx: SIZE,
      auto: !view,
      file: { name: job.name, format: job.ext.toUpperCase(), sizeBytes: job.sizeBytes, sha256: job.sha256 },
    });
    return embedPngText(dataUrlToBytes(renderer.domElement.toDataURL('image/png')), STATE_KEYWORD, JSON.stringify(state, null, 2));
  } finally {
    holder.remove(object);
    disposeObject(object);
  }
}

window.thumbs.onJob((job) => {
  try {
    window.thumbs.done({ id: job.id, png: renderJob(job) });
  } catch (error) {
    window.thumbs.done({ id: job.id, error: error && error.message ? error.message : String(error) });
  }
});
window.thumbs.ready();
