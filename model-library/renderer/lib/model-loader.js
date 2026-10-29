// Turns the bytes of an .stl or .3mf file into a three.js object. Shared by the viewer and the background renderer.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import * as fflate from 'three/addons/libs/fflate.module.js';

export function makeMaterial(vertexColors) {
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : 0x8aa3b5,
    vertexColors: !!vertexColors,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
}

export function countTriangles(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      n += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  return Math.round(n);
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

/**
 * Quick check that a file looks like an STL before the loader is given it. A file that is neither a binary STL
 * (its size matches the triangle count in its header) nor an ASCII STL (starts with "solid") would otherwise be
 * read as binary and fail with a confusing message. Returns a readable problem, or null if it looks fine.
 */
function describeStlProblem(buf) {
  if (buf.byteLength === 0) return 'The file is empty.';
  const startsWithSolid = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 5))).toLowerCase() === 'solid';
  if (buf.byteLength >= 84) {
    const triangleCount = new DataView(buf).getUint32(80, true);
    if (84 + 50 * triangleCount <= buf.byteLength) return null;   // a valid binary STL (extra trailing bytes are tolerated)
  }
  if (startsWithSolid) return null;                                // an ASCII STL
  return 'This is not a valid STL file: it is neither binary STL nor ASCII STL.';
}

/**
 * Parses file contents. `data` may be an ArrayBuffer or any typed array. `ext` is "stl" or "3mf".
 * Returns { object, triangles }. Throws an Error with a readable message if the file cannot be used.
 */
export function parseModel(data, ext) {
  const buf = data instanceof ArrayBuffer
    ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

  let object;
  if (ext === 'stl') {
    const problem = describeStlProblem(buf);
    if (problem) throw new Error(problem);
    const geo = new STLLoader().parse(buf);
    if (!geo.attributes.position || geo.attributes.position.count === 0) throw new Error('the file contains no triangles');
    geo.computeVertexNormals();
    object = new THREE.Mesh(geo, makeMaterial(geo.hasColors));
  } else if (ext === '3mf') {
    // The standard loader keeps colours and materials. If it fails or finds nothing (as it does for
    // Bambu Studio files), fall back to the reader below, which follows external object files.
    try {
      object = new ThreeMFLoader().parse(buf);
      if (!countTriangles(object)) throw new Error('no triangles found');
    } catch (standardError) {
      try {
        object = parse3mfWithComponents(buf);
      } catch (error) {
        throw new Error('This is not a readable 3MF file (' + ((error && error.message) || error) + ').');
      }
    }
    object.traverse((o) => { if (o.isMesh && o.material) o.material.side = THREE.DoubleSide; });
  } else {
    throw new Error('unsupported file type: ' + ext);
  }

  const triangles = countTriangles(object);
  if (!triangles) throw new Error('the file contains no triangles');
  return { object, triangles };
}

/* ---------- 3MF with external object files (Bambu Studio, Orca Slicer, PrusaSlicer) ---------- */
// three.js's 3MFLoader only reads meshes stored in the main 3D/3dmodel.model file. Slicers that use the
// 3MF "production" extension keep each mesh in its own file (3D/Objects/object_1.model) and point to it
// from a <component p:path="..."> element. This small reader follows those links.
function parse3mfWithComponents(buf) {
  let files;
  try {
    files = fflate.unzipSync(new Uint8Array(buf));
  } catch (e) {
    throw new Error('the file is not a valid zip package');   // fflate may throw a non-Error value
  }
  const decoder = new TextDecoder('utf-8');
  const norm = (p) => p.replace(/^\/+/, '');

  const kids = (el, name) => Array.from(el.childNodes).filter((c) => c.nodeType === 1 && c.localName === name);
  const attr = (el, name) => {                       // match by local name so "p:path" and "path" both work
    for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
    return null;
  };
  const readXml = (path) => {
    const data = files[norm(path)];
    if (!data) throw new Error('missing ' + path + ' in the 3MF package');
    const doc = new DOMParser().parseFromString(decoder.decode(data), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid XML in ' + path);
    return doc.documentElement;
  };

  // The main model is named in _rels/.rels; fall back to the usual location.
  let rootPath = '3D/3dmodel.model';
  if (files['_rels/.rels']) {
    const rels = readXml('_rels/.rels');
    for (const r of Array.from(rels.getElementsByTagName('Relationship'))) {
      if (/3dmodel$/i.test(r.getAttribute('Type') || '') && r.getAttribute('Target')) { rootPath = norm(r.getAttribute('Target')); break; }
    }
  }

  const models = {};                                 // path -> { objects: { id: definition } }
  const loadModel = (path) => {
    path = norm(path);
    if (models[path]) return models[path];
    const root = readXml(path);
    const objects = {};
    const resources = kids(root, 'resources')[0];
    if (resources) {
      for (const o of kids(resources, 'object')) {
        const def = { id: o.getAttribute('id'), mesh: null, components: [] };
        const mesh = kids(o, 'mesh')[0];
        if (mesh) {
          const vEl = kids(kids(mesh, 'vertices')[0] || mesh, 'vertex');
          const tEl = kids(kids(mesh, 'triangles')[0] || mesh, 'triangle');
          const pos = new Float32Array(vEl.length * 3);
          vEl.forEach((v, i) => {
            pos[i * 3] = parseFloat(v.getAttribute('x'));
            pos[i * 3 + 1] = parseFloat(v.getAttribute('y'));
            pos[i * 3 + 2] = parseFloat(v.getAttribute('z'));
          });
          const out = new Float32Array(tEl.length * 9);   // non-indexed, so shading stays flat per face
          tEl.forEach((t, i) => {
            const idx = [t.getAttribute('v1'), t.getAttribute('v2'), t.getAttribute('v3')];
            for (let k = 0; k < 3; k++) {
              const s = parseInt(idx[k], 10) * 3;
              out[i * 9 + k * 3] = pos[s];
              out[i * 9 + k * 3 + 1] = pos[s + 1];
              out[i * 9 + k * 3 + 2] = pos[s + 2];
            }
          });
          def.mesh = out;
        }
        const comps = kids(o, 'components')[0];
        if (comps) {
          for (const c of kids(comps, 'component')) {
            def.components.push({ id: c.getAttribute('objectid'), path: attr(c, 'path'), transform: c.getAttribute('transform') });
          }
        }
        objects[def.id] = def;
      }
    }
    models[path] = { root, objects };
    return models[path];
  };

  // 3MF writes a 4x3 matrix for row vectors (v' = v * M); three.js uses column vectors, so transpose.
  const toMatrix = (str) => {
    const m = new THREE.Matrix4();
    if (!str) return m;
    const n = str.trim().split(/\s+/).map(Number);
    if (n.length !== 12 || n.some(Number.isNaN)) return m;
    return m.set(n[0], n[3], n[6], n[9],
                 n[1], n[4], n[7], n[10],
                 n[2], n[5], n[8], n[11],
                 0, 0, 0, 1);
  };

  const build = (path, id, depth) => {
    if (depth > 16) throw new Error('components are nested too deeply');
    const def = loadModel(path).objects[id];
    if (!def) throw new Error('object ' + id + ' not found in ' + path);
    const group = new THREE.Group();
    if (def.mesh && def.mesh.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(def.mesh, 3));
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, makeMaterial(false)));
    }
    for (const c of def.components) {
      const child = build(c.path ? c.path : path, c.id, depth + 1);
      child.matrixAutoUpdate = false;
      child.matrix.copy(toMatrix(c.transform));
      group.add(child);
    }
    return group;
  };

  const result = new THREE.Group();
  const main = loadModel(rootPath);
  const buildEl = kids(main.root, 'build')[0];
  const items = buildEl ? kids(buildEl, 'item') : [];
  for (const item of items) {
    const obj = build(rootPath, item.getAttribute('objectid'), 0);
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(toMatrix(item.getAttribute('transform')));
    result.add(obj);
  }
  if (!items.length) throw new Error('the 3MF has no build items');
  return result;
}
