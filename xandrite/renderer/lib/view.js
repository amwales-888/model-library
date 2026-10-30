// Everything the viewer and the background thumbnail renderer must agree on, so a thumbnail made
// automatically looks exactly like the viewer's default view of the same model.
import * as THREE from 'three';

/* Bump RENDER_VERSION whenever lighting, material, background or framing change. Thumbnails made with an
   older version are then recognised and regenerated. */
export const RENDER_VERSION = 1;
export const STATE_KEYWORD = 'ModelThumbnailer';   // name of the PNG text chunk that holds the view settings
export const THUMB_BG = 0xdfe5ea;                  // thumbnails get a fixed background so they look alike everywhere
export const CAMERA_FOV = 35;                      // vertical field of view in degrees
export const VIEW_DIR = new THREE.Vector3(1, 0.8, 1).normalize();   // direction of the default view

export const r3 = (v) => Math.round(v * 1000) / 1000;

export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a0, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(-4, 2, -3);
  scene.add(fill);
}

/**
 * Rotates the holder so the file's Z axis points up (if zUp), and moves it so the middle of its bounding box
 * is at the origin. Returns the radius: half the diagonal of that box.
 * STL and 3MF files from slicers and CAD tools are normally Z-up; three.js is Y-up.
 */
export function orientAndCentre(holder, zUp) {
  holder.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0);
  holder.position.set(0, 0, 0);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  holder.position.sub(box.getCenter(new THREE.Vector3()));
  holder.updateMatrixWorld(true);
  return box.getSize(new THREE.Vector3()).length() / 2 || 1;
}

/** Distance from the origin at which a model of the given radius just fits the view, with a small margin. */
export function fitDistance(radius, fovDeg, aspect) {
  const vfov = THREE.MathUtils.degToRad(fovDeg);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  return (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.08;
}

/** Places a camera on the default view direction, framed for a model of the given radius, looking at the origin. */
export function placeDefaultCamera(camera, radius, aspect) {
  const dist = fitDistance(radius, camera.fov, aspect);
  camera.position.copy(VIEW_DIR).multiplyScalar(dist);
  camera.near = Math.max(radius * 0.01, 0.0001);
  camera.far = dist + radius * 6;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
}

/**
 * Puts a camera at a stored view (position, target, field of view). The clipping planes are worked out from the
 * model's radius and the camera's distance, so a view that was zoomed out or in still shows the whole model.
 */
export function placeStoredCamera(camera, view, radius, aspect) {
  const position = new THREE.Vector3(...view.position);
  const target = new THREE.Vector3(...view.target);
  const dist = position.distanceTo(target) || 1;
  camera.fov = view.fovDeg;
  camera.position.copy(position);
  camera.near = Math.max(Math.min(radius * 0.01, dist * 0.5), 0.0001);
  camera.far = dist + radius * 6;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
}

/**
 * Everything needed to recreate an image: the camera pose (position, target, up), the projection (field of view),
 * the model orientation (Z-up) and the render settings. This is what gets stored inside each thumbnail PNG.
 */
export function buildViewState({ position, target, fovDeg, zUp, sizePx, file, auto = false }) {
  const d = position.distanceTo(target) || 1;
  return {
    app: 'Model Thumbnailer',
    renderVersion: RENDER_VERSION,
    auto,   // true when the thumbnail was made automatically with the default view
    file: file || null,
    camera: {
      position: [r3(position.x), r3(position.y), r3(position.z)],
      target: [r3(target.x), r3(target.y), r3(target.z)],
      up: [0, 1, 0],
      fovDeg: r3(fovDeg),
      distance: r3(d),
      azimuthDeg: r3(THREE.MathUtils.radToDeg(Math.atan2(position.x - target.x, position.z - target.z))),
      elevationDeg: r3(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp((position.y - target.y) / d, -1, 1)))),
    },
    zUp,
    thumbnail: { sizePx, background: '#' + THUMB_BG.toString(16).padStart(6, '0') },
    space: 'Y-up. The model is centred on its bounding-box centre at the origin. If zUp is true, the file Z axis was rotated to point up.',
  };
}
