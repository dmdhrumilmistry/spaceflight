// Procedural International Space Station built to real dimensions (metres).
// Station frame: -Z = velocity direction (+XVV "forward"), +Y = zenith,
// +X = starboard (integrated truss axis). Docking port = PMA-2 / IDA-2 on
// Harmony forward. Static structure is merged per material to keep draw calls
// low (phones); solar arrays rotate on alpha (SARJ, about X) and beta gimbals.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { panelTexture, radialGlowTexture, dockingTargetTexture, foilNormalTexture } from './textures.js';

/** Docking interface (IDA-2 soft-capture ring face) in the station frame. */
export const ISS_PORT_LOCAL = new THREE.Vector3(0, 0, -20.6);

const TRUSS_Y = 5.5; // truss centreline above the lab/node axis
const TRUSS_Z = -5.95; // S0 sits on top of Destiny
const TRUSS_HY = 2.0; // half height of the truss box
const TRUSS_HZ = 2.2; // half depth
const SARJ_X = 27.9;

// ---------------------------------------------------------------- textures
function canvas(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return [c, c.getContext('2d')];
}

/** Quilted beta-cloth normal map (pillowed blanket squares). */
function quiltNormalTexture() {
  const N = 256;
  const cells = 4;
  const [c, g] = canvas(N);
  const img = g.createImageData(N, N);
  const h = (x, y) => {
    const u = ((x / N) * cells) % 1;
    const v = ((y / N) * cells) % 1;
    return Math.pow(Math.sin(Math.PI * u) * Math.sin(Math.PI * v), 0.6);
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = h(x + 1, y) - h(x - 1 + N, y);
      const dy = h(x, y + 1) - h(x, y - 1 + N);
      const nx = -dx * 2.2;
      const ny = -dy * 2.2;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Copper-gold photovoltaic blanket: 8×8 cells per tile with bus lines. */
function arrayCellTexture() {
  const N = 512;
  const [c, g] = canvas(N);
  g.fillStyle = '#2a1a0c';
  g.fillRect(0, 0, N, N);
  const n = 8;
  const s = N / n;
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 0.85 + rnd() * 0.25;
      const grad = g.createLinearGradient(x * s, y * s, x * s + s, y * s + s);
      grad.addColorStop(0, `rgb(${178 * v | 0},${116 * v | 0},${52 * v | 0})`);
      grad.addColorStop(1, `rgb(${138 * v | 0},${86 * v | 0},${36 * v | 0})`);
      g.fillStyle = grad;
      g.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
      g.strokeStyle = 'rgba(230,200,150,0.35)';
      g.lineWidth = 1;
      for (let k = 1; k < 4; k++) {
        g.beginPath();
        g.moveTo(x * s + 2, y * s + (k * s) / 4);
        g.lineTo(x * s + s - 2, y * s + (k * s) / 4);
        g.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Simple blue-black cell texture for Russian-segment / visiting-vehicle arrays. */
function blueCellTexture() {
  const N = 256;
  const [c, g] = canvas(N);
  g.fillStyle = '#0a0f22';
  g.fillRect(0, 0, N, N);
  const n = 8;
  const s = N / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#18264f' : '#142046';
      g.fillRect(x * s + 1.5, y * s + 1.5, s - 3, s - 3);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------- geometry helpers
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function xf(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  return _m.clone().compose(_p, _q, _s);
}

function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

/** Collects geometry per material and merges it into one mesh per material. */
class Builder {
  constructor() {
    this.parts = new Map();
  }
  add(geo, mat, matrix) {
    if (matrix) geo.applyMatrix4(matrix);
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(geo);
    return geo;
  }
  build(parent, { cast = true, receive = true } = {}) {
    const meshes = [];
    for (const [mat, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.parts.clear();
    return meshes;
  }
}

export class IssModel {
  constructor({ quality = 'high' } = {}) {
    const low = quality === 'low';
    this.seg = low ? 16 : quality === 'medium' ? 28 : 40;
    this.group = new THREE.Group();
    this.group.name = 'ISS';
    this.colliders = [];
    this.dynamic = []; // { node chain, localBox, collider }
    this.lights = [];
    this.time = 0;

    const quilt = quiltNormalTexture();
    const foil = foilNormalTexture(23);
    const radTex = panelTexture('#f4f4f0', '#c8c8c2', 31, 8);
    this.mat = {
      cloth: new THREE.MeshStandardMaterial({
        color: 0xe9e6dd,
        roughness: 0.82,
        metalness: 0.0,
        normalMap: quilt,
        normalScale: new THREE.Vector2(0.45, 0.45),
      }),
      clothRu: new THREE.MeshStandardMaterial({
        color: 0xdedcd2,
        roughness: 0.85,
        normalMap: foil,
        normalScale: new THREE.Vector2(0.35, 0.35),
      }),
      metal: new THREE.MeshStandardMaterial({ color: 0xa9adb3, roughness: 0.42, metalness: 0.85 }),
      truss: new THREE.MeshStandardMaterial({ color: 0x9ea2a8, roughness: 0.5, metalness: 0.75 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf0efea, roughness: 0.55, metalness: 0.05 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2b2c31, roughness: 0.65, metalness: 0.4 }),
      mli: new THREE.MeshStandardMaterial({ color: 0x34363b, roughness: 0.7, metalness: 0.2, normalMap: foil, normalScale: new THREE.Vector2(0.4, 0.4) }),
      gold: new THREE.MeshPhysicalMaterial({ color: 0xc9953d, metalness: 1, roughness: 0.32, normalMap: foil, normalScale: new THREE.Vector2(0.6, 0.6) }),
      rail: new THREE.MeshStandardMaterial({ color: 0xd0a43a, roughness: 0.5, metalness: 0.6 }),
      radiator: new THREE.MeshStandardMaterial({ map: radTex, color: 0xffffff, roughness: 0.38, metalness: 0.05, side: THREE.DoubleSide }),
      arrayFront: new THREE.MeshPhysicalMaterial({
        map: arrayCellTexture(),
        color: 0xffffff,
        roughness: 0.36,
        metalness: 0.35,
        clearcoat: 0.6,
        clearcoatRoughness: 0.2,
      }),
      arrayBack: new THREE.MeshStandardMaterial({ color: 0xcfcbbf, roughness: 0.8, metalness: 0.0 }),
      blueArray: new THREE.MeshPhysicalMaterial({ map: blueCellTexture(), roughness: 0.3, metalness: 0.4, clearcoat: 0.8, side: THREE.DoubleSide }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x06080c, roughness: 0.05, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.03 }),
      soyuz: new THREE.MeshStandardMaterial({ color: 0x8c9479, roughness: 0.75, metalness: 0.1, normalMap: foil, normalScale: new THREE.Vector2(0.5, 0.5) }),
      target: new THREE.MeshStandardMaterial({ map: dockingTargetTexture(), roughness: 0.6, emissive: 0x303030 }),
    };

    const B = new Builder();
    this.buildPressurized(B);
    this.buildRussian(B);
    this.buildInboardTruss(B);
    this.buildRadiators(B);
    this.buildArm(B);
    this.buildPort(B);
    B.build(this.group);

    this.buildAlphaSides(quality);
    this.buildZvezdaArrays();
    this.buildLights();
    this.update(0, new THREE.Vector3(0, 1, 0));
  }

  // ---------------------------------------------------------------- helpers
  collider(cx, cy, cz, hx, hy, hz) {
    const c = { min: new THREE.Vector3(cx - hx, cy - hy, cz - hz), max: new THREE.Vector3(cx + hx, cy + hy, cz + hz) };
    this.colliders.push(c);
    return c;
  }

  /** Cylinder module along an axis ('x' | 'y' | 'z'), with end rings and handrails. */
  module(B, axis, r, len, cx, cy, cz, { mat = this.mat.cloth, rails = true, rings = true, capR = r * 0.72 } = {}) {
    const seg = this.seg;
    const rot = axis === 'z' ? [Math.PI / 2, 0, 0] : axis === 'x' ? [0, 0, Math.PI / 2] : [0, 0, 0];
    const body = scaleUV(new THREE.CylinderGeometry(r, r, len, seg, 1, false), (2 * Math.PI * r) / 1.2, len / 1.2);
    B.add(body, mat, xf(cx, cy, cz, ...rot));
    if (rings) {
      for (const s of [-1, 1]) {
        B.add(new THREE.CylinderGeometry(r * 1.015, r * 1.015, 0.28, seg, 1, true), this.mat.metal, xf(cx, cy, cz, ...rot).multiply(xf(0, s * (len / 2 - 0.25), 0)));
        // berthing / hatch end cone
        B.add(new THREE.CylinderGeometry(capR, r, 0.45, seg, 1, false), this.mat.metal, xf(cx, cy, cz, ...rot).multiply(xf(0, s * (len / 2 + 0.2), 0, s > 0 ? 0 : Math.PI, 0, 0)));
      }
    }
    if (rails && seg > 16) {
      for (const a of [0.55, 2.6, 3.7, 5.75]) {
        const rail = new THREE.BoxGeometry(0.05, len * 0.86, 0.05);
        B.add(rail, this.mat.rail, xf(cx, cy, cz, ...rot).multiply(xf(Math.cos(a) * (r + 0.12), 0, Math.sin(a) * (r + 0.12))));
      }
    }
    const h = len / 2 + 0.45;
    if (axis === 'z') this.collider(cx, cy, cz, r, r, h);
    else if (axis === 'x') this.collider(cx, cy, cz, h, r, r);
    else this.collider(cx, cy, cz, r, h, r);
  }

  // ---------------------------------------------------------------- US segment
  buildPressurized(B) {
    const M = this.mat;
    const seg = this.seg;
    // main stack along Z (forward = -Z)
    this.module(B, 'z', 2.2, 7.2, 0, 0, -14.0); // Harmony (Node 2)
    this.module(B, 'z', 2.15, 8.5, 0, 0, -5.95); // Destiny
    this.module(B, 'z', 2.25, 5.5, 0, 0, 1.25); // Unity (Node 1)
    // PMA-1 (Unity -> Zarya)
    B.add(new THREE.CylinderGeometry(1.15, 1.35, 2.2, seg), M.cloth, xf(0, 0, 5.1, -Math.PI / 2, 0, 0));
    this.collider(0, 0, 5.1, 1.35, 1.35, 1.1);

    // Columbus (Harmony starboard) + external payload facility
    this.module(B, 'x', 2.25, 6.9, 5.65 + 0.2, 0, -14.0);
    for (const [y, z] of [
      [1.6, -15.8],
      [-1.6, -15.8],
      [1.6, -12.2],
    ]) B.add(new THREE.BoxGeometry(1.2, 1.0, 0.9), M.white, xf(9.6, y, z));
    // Kibo pressurised module (Harmony port) + logistics + exposed facility
    this.module(B, 'x', 2.2, 11.2, -7.8 - 0.2, 0, -14.0);
    this.module(B, 'y', 2.1, 4.2, -8.5, 2.2 + 2.1 + 0.3, -14.0); // ELM-PS
    B.add(new THREE.BoxGeometry(5.6, 0.9, 5.0), M.metal, xf(-16.9, -0.6, -14.0));
    this.collider(-16.9, -0.2, -14.0, 2.8, 1.3, 2.5);
    for (let k = 0; k < 6; k++) {
      const x = -14.8 - (k % 3) * 1.8;
      const z = -15.3 + Math.floor(k / 3) * 2.5;
      B.add(new THREE.BoxGeometry(1.4, 0.9 + (k % 2) * 0.5, 1.8), k % 2 ? M.white : M.mli, xf(x, 0.3 + (k % 2) * 0.25, z));
    }
    // PMA-3 / IDA-3 on Harmony zenith
    B.add(new THREE.CylinderGeometry(0.95, 1.15, 2.2, seg), M.cloth, xf(0, 2.2 + 1.1 + 0.4, -14.0));
    B.add(new THREE.CylinderGeometry(0.9, 0.9, 0.5, seg), M.metal, xf(0, 2.2 + 2.2 + 0.65, -14.0));
    this.collider(0, 3.9, -14.0, 1.2, 1.5, 1.2);

    // Quest airlock (Unity starboard)
    this.module(B, 'x', 2.0, 3.0, 2.25 + 1.6, 0, 1.25, { rails: false });
    this.module(B, 'x', 1.6, 2.4, 2.25 + 3.0 + 1.4, 0, 1.25, { rails: false });
    for (const [y, z] of [
      [1.9, 2.9],
      [1.9, -0.4],
      [-1.9, 2.9],
      [-1.9, -0.4],
    ]) B.add(new THREE.SphereGeometry(0.6, 16, 12), M.white, xf(4.2, y, z));

    // Tranquility (Node 3) on Unity port, Cupola nadir, Leonardo forward, BEAM aft
    const n3x = -2.25 - 3.35 - 0.3;
    this.module(B, 'x', 2.25, 6.7, n3x, 0, 1.25);
    this.buildCupola(B, n3x, -2.25, 1.25);
    this.module(B, 'z', 2.2, 6.4, n3x, 0, 1.25 - 2.25 - 3.2 - 0.3); // Leonardo PMM
    B.add(new THREE.CylinderGeometry(1.6, 1.6, 3.6, seg), M.white, xf(n3x, 0, 1.25 + 2.25 + 2.1, Math.PI / 2, 0, 0)); // BEAM
    B.add(new THREE.SphereGeometry(1.6, seg, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.white, xf(n3x, 0, 1.25 + 2.25 + 3.9, Math.PI / 2, 0, 0));
    this.collider(n3x, 0, 1.25 + 2.25 + 2.6, 1.6, 1.6, 2.3);
  }

  buildCupola(B, x, yTop, z) {
    const M = this.mat;
    // seven-window observation dome: hexagonal frustum + top window
    const h = 1.3;
    const frame = new THREE.CylinderGeometry(1.0, 1.5, h, 6, 1, true);
    B.add(frame, M.metal, xf(x, yTop - h / 2 - 0.3, z, 0, Math.PI / 6, 0));
    const glass = new THREE.CylinderGeometry(0.93, 1.42, h * 0.8, 6, 1, true);
    B.add(glass, M.glass, xf(x, yTop - h / 2 - 0.3, z, 0, Math.PI / 6, 0));
    B.add(new THREE.CylinderGeometry(1.5, 1.6, 0.35, 24), M.cloth, xf(x, yTop - 0.15, z));
    B.add(new THREE.CylinderGeometry(1.0, 1.0, 0.1, 24), M.metal, xf(x, yTop - h - 0.3, z));
    B.add(new THREE.CylinderGeometry(0.62, 0.62, 0.11, 24), M.glass, xf(x, yTop - h - 0.31, z));
    // shutter / frame edges
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const e = new THREE.BoxGeometry(0.08, h, 0.08);
      B.add(e, M.metal, xf(x + Math.cos(a) * 1.25, yTop - h / 2 - 0.3, z + Math.sin(a) * 1.25, Math.sin(a) * 0.36, 0, -Math.cos(a) * 0.36));
    }
    this.collider(x, yTop - 0.85, z, 1.6, 0.9, 1.6);
  }

  // ---------------------------------------------------------------- Russian segment + visiting vehicles
  buildRussian(B) {
    const M = this.mat;
    const seg = this.seg;
    // Zarya (FGB)
    this.module(B, 'z', 2.05, 9.6, 0, 0, 13.4, { mat: M.clothRu, rails: false });
    B.add(new THREE.CylinderGeometry(1.4, 2.05, 2.4, seg), M.clothRu, xf(0, 0, 7.4, -Math.PI / 2, 0, 0));
    this.collider(0, 0, 7.4, 2.05, 2.05, 1.2);
    // Rassvet (MRM-1) on Zarya nadir + docked crew vehicle
    this.module(B, 'y', 1.17, 6.0, 0, -2.05 - 3.0, 12.5, { mat: M.clothRu, rails: false, rings: false });
    this.buildSoyuz(B, 0, -2.05 - 6.0, 12.5, -1);
    // Zvezda: spherical transfer compartment, working compartment, aft
    B.add(new THREE.SphereGeometry(1.3, seg, 16), M.clothRu, xf(0, 0, 20.1));
    this.collider(0, 0, 20.1, 1.3, 1.3, 1.3);
    this.module(B, 'z', 1.45, 3.0, 0, 0, 22.9, { mat: M.clothRu, rails: false });
    this.module(B, 'z', 2.1, 7.4, 0, 0, 28.1, { mat: M.clothRu, rails: false });
    B.add(new THREE.CylinderGeometry(2.1, 1.35, 1.0, seg), M.mli, xf(0, 0, 32.3, Math.PI / 2, 0, 0));
    this.collider(0, 0, 32.3, 2.1, 2.1, 0.5);
    for (const a of [0.3, 2.0, 3.6, 5.2]) B.add(new THREE.BoxGeometry(0.9, 0.5, 1.2), M.dark, xf(Math.cos(a) * 2.2, Math.sin(a) * 2.2, 25.0, 0, 0, a));
    // Poisk (zenith) and Nauka + Prichal (nadir) on the transfer compartment
    this.module(B, 'y', 1.27, 4.0, 0, 1.3 + 2.0, 20.1, { mat: M.clothRu, rails: false, rings: false });
    this.module(B, 'y', 2.05, 12.0, 0, -1.3 - 6.0, 20.1, { mat: M.clothRu, rails: false });
    B.add(new THREE.SphereGeometry(1.2, seg, 14), M.clothRu, xf(0, -14.6, 20.1));
    this.collider(0, -14.6, 20.1, 1.2, 1.2, 1.2);
    // Nauka's small arrays
    for (const s of [-1, 1]) {
      B.add(new THREE.BoxGeometry(6.0, 0.05, 2.2), M.blueArray, xf(s * (2.05 + 3.2), -9.5, 20.1));
      this.collider(s * (2.05 + 3.2), -9.5, 20.1, 3.0, 0.2, 1.1);
    }
    // cargo vehicle at Zvezda aft
    this.buildProgress(B, 0, 0, 32.8);
  }

  buildSoyuz(B, x, y0, z, dir) {
    const M = this.mat;
    const seg = this.seg;
    // dir = -1: hangs toward -Y (nadir)
    const at = (d) => y0 + dir * d;
    B.add(new THREE.SphereGeometry(1.1, seg, 16), M.soyuz, xf(x, at(1.3), z, 0, 0, 0)); // orbital module
    B.add(new THREE.CylinderGeometry(0.7, 1.1, 2.0, seg), M.soyuz, xf(x, at(3.3), z, dir < 0 ? 0 : Math.PI, 0, 0)); // descent module
    B.add(new THREE.CylinderGeometry(1.1, 1.1, 0.25, seg), M.dark, xf(x, at(4.4), z));
    B.add(new THREE.CylinderGeometry(1.1, 1.36, 2.6, seg), M.white, xf(x, at(5.8), z, dir < 0 ? 0 : Math.PI, 0, 0)); // service module
    for (const s of [-1, 1]) {
      B.add(new THREE.BoxGeometry(4.0, 0.05, 1.3), M.blueArray, xf(x + s * (1.36 + 2.1), at(5.8), z));
    }
    this.collider(x, at(3.6), z, 1.4, 3.6, 1.4);
    this.collider(x, at(5.8), z, 5.5, 0.3, 0.7);
  }

  buildProgress(B, x, y, z0) {
    const M = this.mat;
    const seg = this.seg;
    B.add(new THREE.CylinderGeometry(1.35, 1.35, 3.0, seg), M.soyuz, xf(x, y, z0 + 1.6, Math.PI / 2, 0, 0));
    B.add(new THREE.CylinderGeometry(1.1, 1.1, 1.4, seg), M.white, xf(x, y, z0 + 3.8, Math.PI / 2, 0, 0));
    B.add(new THREE.CylinderGeometry(1.36, 1.36, 2.6, seg), M.white, xf(x, y, z0 + 5.8, Math.PI / 2, 0, 0));
    for (const s of [-1, 1]) B.add(new THREE.BoxGeometry(4.6, 0.05, 1.3), M.blueArray, xf(x + s * (1.36 + 2.4), y, z0 + 5.8));
    this.collider(x, y, z0 + 3.6, 1.4, 1.4, 3.6);
    this.collider(x, y, z0 + 5.8, 6.0, 0.3, 0.7);
  }

  // ---------------------------------------------------------------- integrated truss
  /** Lattice truss segment from x0 to x1 (in the given builder's frame, centred on the truss axis at (0, cy, cz)). */
  trussSegment(B, x0, x1, cy, cz, { greebles = true, seedOff = 0 } = {}) {
    const M = this.mat;
    const len = x1 - x0;
    const cx = (x0 + x1) / 2;
    const hy = TRUSS_HY;
    const hz = TRUSS_HZ;
    for (const [dy, dz] of [
      [-hy, -hz],
      [-hy, hz],
      [hy, -hz],
      [hy, hz],
    ]) B.add(new THREE.BoxGeometry(len, 0.2, 0.2), M.truss, xf(cx, cy + dy, cz + dz));
    const bays = Math.max(1, Math.round(len / 2.6));
    const step = len / bays;
    for (let i = 0; i <= bays; i++) {
      const x = x0 + i * step;
      for (const dz of [-hz, hz]) B.add(new THREE.BoxGeometry(0.12, hy * 2, 0.12), M.truss, xf(x, cy, cz + dz));
      for (const dy of [-hy, hy]) B.add(new THREE.BoxGeometry(0.12, 0.12, hz * 2), M.truss, xf(x, cy + dy, cz));
      if (i < bays && this.seg > 16) {
        const diag = Math.hypot(step, hy * 2);
        const ang = Math.atan2(hy * 2, step) * (i % 2 ? 1 : -1);
        for (const dz of [-hz, hz]) B.add(new THREE.BoxGeometry(diag, 0.09, 0.09), M.truss, xf(x + step / 2, cy, cz + dz, 0, 0, ang));
      }
    }
    // equipment boxes (ORUs), batteries, MLI-covered avionics
    if (greebles && this.seg > 16) {
      let s = (Math.abs(x0 * 13.1 + x1 * 7.7) | 0) + 3 + seedOff;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const n = Math.round(len / 2.2);
      const mats = [M.white, M.mli, M.metal, M.white, M.gold];
      for (let k = 0; k < n; k++) {
        const x = x0 + 0.8 + rnd() * (len - 1.6);
        const face = (rnd() * 3) | 0;
        const w = 0.6 + rnd() * 1.4;
        const h = 0.4 + rnd() * 0.9;
        const d = 0.6 + rnd() * 1.4;
        const mat = mats[(rnd() * mats.length) | 0];
        if (face === 0) B.add(new THREE.BoxGeometry(w, h, d), mat, xf(x, cy + (rnd() - 0.5) * 2.4, cz - hz + d / 2 - 0.1)); // forward face
        else if (face === 1) B.add(new THREE.BoxGeometry(w, h, d), mat, xf(x, cy + (rnd() - 0.5) * 2.4, cz + hz - d / 2 + 0.1)); // aft face
        else B.add(new THREE.BoxGeometry(w, d, h), mat, xf(x, cy + hy - d / 2 + 0.1, cz + (rnd() - 0.5) * 3)); // inside top
      }
    }
  }

  buildInboardTruss(B) {
    const M = this.mat;
    // S0, S1/P1, S3/P3 (static part, inboard of the alpha joints)
    this.trussSegment(B, -6.7, 6.7, TRUSS_Y, TRUSS_Z);
    this.trussSegment(B, 6.7, 20.4, TRUSS_Y, TRUSS_Z);
    this.trussSegment(B, -20.4, -6.7, TRUSS_Y, TRUSS_Z);
    this.trussSegment(B, 20.4, SARJ_X - 0.5, TRUSS_Y, TRUSS_Z);
    this.trussSegment(B, -(SARJ_X - 0.5), -20.4, TRUSS_Y, TRUSS_Z);
    // S0 core box + mounting struts to Destiny
    B.add(new THREE.BoxGeometry(12.0, 3.4, 3.8), M.white, xf(0, TRUSS_Y, TRUSS_Z));
    for (const [x, z] of [
      [-2.5, -2.0],
      [2.5, -2.0],
      [-2.5, 2.0],
      [2.5, 2.0],
    ]) B.add(new THREE.CylinderGeometry(0.12, 0.12, 2.0, 8), M.metal, xf(x * 0.6, 2.9, TRUSS_Z + z * 0.8, 0, 0, x > 0 ? -0.35 : 0.35));
    // SARJ rings (static halves)
    for (const s of [-1, 1]) {
      B.add(new THREE.CylinderGeometry(2.9, 2.9, 0.6, this.seg), M.metal, xf(s * (SARJ_X - 0.2), TRUSS_Y, TRUSS_Z, 0, 0, Math.PI / 2));
    }
    this.collider(0, TRUSS_Y, TRUSS_Z, SARJ_X + 0.3, TRUSS_HY + 0.4, TRUSS_HZ + 0.6);
    // mobile transporter rails on the forward face
    for (const dy of [-0.8, 0.8]) B.add(new THREE.BoxGeometry(2 * 20.4, 0.12, 0.12), M.metal, xf(0, TRUSS_Y + dy, TRUSS_Z - TRUSS_HZ - 0.12));
  }

  buildRadiators(B) {
    // Heat Rejection System radiators on S1 and P1: three long panels per side,
    // deployed aft and nadir at ~45°.
    const ang = 0.78;
    const dir = new THREE.Vector3(0, -Math.sin(ang), Math.cos(ang));
    const L = 23.0;
    const W = 3.2;
    for (const s of [-1, 1]) {
      for (const x of [11.5, 15.0, 18.5]) {
        const c = new THREE.Vector3(s * x, TRUSS_Y, TRUSS_Z).addScaledVector(dir, TRUSS_HZ + 0.4 + L / 2);
        const geo = scaleUV(new THREE.BoxGeometry(W, 0.06, L), 1, 6);
        B.add(geo, this.mat.radiator, xf(c.x, c.y, c.z, -ang, 0, 0));
        // AABB of the tilted panel
        const hy = (Math.sin(ang) * L) / 2 + 0.1;
        const hz = (Math.cos(ang) * L) / 2 + 0.1;
        this.collider(c.x, c.y, c.z, W / 2, hy, hz);
      }
      B.add(new THREE.BoxGeometry(10.5, 0.3, 0.3), this.mat.metal, xf(s * 15.0, TRUSS_Y - TRUSS_HY * 0.7, TRUSS_Z + TRUSS_HZ));
    }
  }

  buildArm(B) {
    // Canadarm2 on the mobile base, forward face of the truss (starboard of S0)
    const M = this.mat;
    const base = new THREE.Vector3(6.0, TRUSS_Y + 0.6, TRUSS_Z - TRUSS_HZ - 0.7);
    const elbow = new THREE.Vector3(6.0, TRUSS_Y + 6.8, TRUSS_Z - TRUSS_HZ - 3.2);
    const wrist = new THREE.Vector3(6.0, TRUSS_Y + 2.6, TRUSS_Z - TRUSS_HZ - 9.0);
    B.add(new THREE.BoxGeometry(5.0, 2.4, 1.0), M.white, xf(6.0, TRUSS_Y, TRUSS_Z - TRUSS_HZ - 0.5));
    const boom = (a, b, r) => {
      const d = b.clone().sub(a);
      const g = new THREE.CylinderGeometry(r, r, d.length(), 14);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
      B.add(g, M.white, m);
    };
    boom(base, elbow, 0.2);
    boom(elbow, wrist, 0.2);
    for (const p of [base, elbow, wrist]) B.add(new THREE.CylinderGeometry(0.32, 0.32, 0.7, 14), M.metal, xf(p.x, p.y, p.z, 0, 0, Math.PI / 2));
    B.add(new THREE.CylinderGeometry(0.35, 0.25, 0.8, 14), M.dark, xf(wrist.x, wrist.y - 0.5, wrist.z));
    this.collider(6.0, TRUSS_Y + 3.5, TRUSS_Z - TRUSS_HZ - 4.5, 0.8, 4.2, 4.8);
  }

  buildPort(B) {
    const M = this.mat;
    const seg = this.seg;
    const pz = ISS_PORT_LOCAL.z; // -20.6
    // PMA-2: conical adapter on Harmony forward, then IDA-2
    B.add(new THREE.CylinderGeometry(0.98, 1.2, 2.3, seg), M.cloth, xf(0, 0, -17.6 - 0.45 - 1.15, -Math.PI / 2, 0, 0));
    B.add(new THREE.CylinderGeometry(0.92, 0.92, 0.55, seg), M.metal, xf(0, 0, pz + 0.38, Math.PI / 2, 0, 0));
    B.add(new THREE.TorusGeometry(0.86, 0.075, 12, seg), M.metal, xf(0, 0, pz + 0.075));
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
      B.add(new THREE.BoxGeometry(0.22, 0.32, 0.26), M.metal, xf(Math.cos(a) * 0.66, Math.sin(a) * 0.66, pz + 0.12, 0, 0, a));
    }
    // reflective docking target on a standoff above the port (centreline target)
    const disk = new THREE.CircleGeometry(0.42, 32);
    B.add(disk, M.target, xf(0, 1.75, pz + 0.75, 0, Math.PI, 0));
    B.add(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8), M.dark, xf(0, 1.75, pz + 1.2, Math.PI / 2, 0, 0));
    B.add(new THREE.BoxGeometry(0.1, 0.8, 0.1), M.metal, xf(0, 1.3, pz + 1.6));
    // collider ends exactly at the port face
    this.collider(0, 0, (pz + -17.2) / 2, 1.25, 1.25, (-17.2 - pz) / 2);
  }

  // ---------------------------------------------------------------- rotating outboard truss + arrays
  buildAlphaSides(quality) {
    this.alpha = [];
    this.betas = [];
    for (const s of [-1, 1]) {
      const alpha = new THREE.Group();
      alpha.position.set(0, TRUSS_Y, TRUSS_Z);
      this.group.add(alpha);
      this.alpha.push(alpha);
      const B = new Builder();
      // outboard truss: S4/P4 (IEA), S5/P5, S6/P6 — built in the alpha frame (truss axis at y = z = 0)
      const a = s * (SARJ_X + 0.3);
      const segs = [
        [SARJ_X + 0.3, 35.4],
        [35.4, 39.0],
        [39.0, 53.6],
      ];
      for (const [x0, x1] of segs) {
        const lo = s > 0 ? x0 : -x1;
        const hi = s > 0 ? x1 : -x0;
        this.trussSegment(B, lo, hi, 0, 0, { seedOff: s > 0 ? 0 : 99 });
      }
      B.add(new THREE.CylinderGeometry(2.9, 2.9, 0.6, this.seg), this.mat.metal, xf(a, 0, 0, 0, 0, Math.PI / 2));
      // IEA equipment and beta gimbal housings
      for (const xc of [33.0, 47.4]) {
        B.add(new THREE.BoxGeometry(5.0, 3.2, 3.6), this.mat.white, xf(s * xc, 0, 0));
        for (const dy of [-1, 1]) B.add(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 16), this.mat.metal, xf(s * xc, dy * (TRUSS_HY + 0.9), 0));
      }
      // photovoltaic radiators (PVR), deployed aft in the alpha frame
      for (const xc of [33.0, 47.4]) {
        const L = 13.6;
        const geo = scaleUV(new THREE.BoxGeometry(3.4, 0.06, L), 1, 4);
        const zc = TRUSS_HZ + 0.8 + L / 2;
        B.add(geo, this.mat.radiator, xf(s * xc, 0, zc));
        this.addDynamic([alpha], new THREE.Box3(new THREE.Vector3(s * xc - 1.8, -0.2, zc - L / 2), new THREE.Vector3(s * xc + 1.8, 0.2, zc + L / 2)));
      }
      B.build(alpha);
      this.addDynamic([alpha], new THREE.Box3(new THREE.Vector3(Math.min(a, s * 53.8), -TRUSS_HY - 1.8, -TRUSS_HZ - 0.4), new THREE.Vector3(Math.max(a, s * 53.8), TRUSS_HY + 1.8, TRUSS_HZ + 0.4)));

      // four solar array wings per side (two per PV module, opposite directions)
      for (const xc of [33.0, 47.4]) {
        for (const dir of [1, -1]) {
          const beta = new THREE.Group();
          beta.position.set(s * xc, dir * (TRUSS_HY + 1.5), 0);
          alpha.add(beta);
          this.betas.push(beta);
          this.buildWing(beta, dir, quality);
          const inner = 0.6;
          const outer = 35.0;
          this.addDynamic(
            [alpha, beta],
            new THREE.Box3(new THREE.Vector3(-6.0, dir > 0 ? inner : -outer, -0.3), new THREE.Vector3(6.0, dir > 0 ? outer : -inner, 0.3)),
          );
        }
      }
    }
  }

  /** One Solar Array Wing: two 4.6 m × 32 m blankets either side of a central mast. */
  buildWing(parent, dir, quality) {
    const B = new Builder();
    const M = this.mat;
    const L = 32.0;
    const W = 4.6;
    const y0 = 1.6; // blanket starts beyond the box/canister
    const yc = dir * (y0 + L / 2);
    for (const sx of [-1, 1]) {
      const x = sx * (0.55 + W / 2);
      const front = scaleUV(new THREE.PlaneGeometry(W, L), W / 1.15, L / 1.15);
      B.add(front, M.arrayFront, xf(x, yc, 0.02));
      const back = new THREE.PlaneGeometry(W, L);
      B.add(back, M.arrayBack, xf(x, yc, -0.02, 0, Math.PI, 0));
      // tensioning edge bars
      B.add(new THREE.BoxGeometry(W, 0.12, 0.12), M.dark, xf(x, dir * (y0 + L + 0.05), 0));
    }
    // mast (coilable lattice), blanket box at the root, tip box
    B.add(new THREE.BoxGeometry(0.5, L + 0.6, 0.5), M.truss, xf(0, dir * (y0 + L / 2), 0));
    if (quality !== 'low') {
      for (let k = 0; k < 14; k++) B.add(new THREE.BoxGeometry(0.62, 0.05, 0.62), M.truss, xf(0, dir * (y0 + (k + 0.5) * (L / 14)), 0));
    }
    B.add(new THREE.BoxGeometry(11.2, 0.5, 0.45), M.white, xf(0, dir * 1.1, 0));
    B.add(new THREE.BoxGeometry(11.2, 0.25, 0.3), M.metal, xf(0, dir * (y0 + L + 0.3), 0));
    B.add(new THREE.CylinderGeometry(0.35, 0.35, 1.2, 12), M.metal, xf(0, dir * 0.2, 0));
    B.build(parent);
  }

  buildZvezdaArrays() {
    // Zvezda's two wings (~29.7 m tip to tip), rotating about X
    this.zvezda = new THREE.Group();
    this.zvezda.position.set(0, 0, 28.0);
    const B = new Builder();
    for (const s of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        B.add(scaleUV(new THREE.BoxGeometry(2.7, 0.05, 3.4), 2, 2), this.mat.blueArray, xf(s * (3.0 + k * 2.85), 0, 0));
      }
      B.add(new THREE.BoxGeometry(11.5, 0.12, 0.12), this.mat.metal, xf(s * (2.1 + 5.75), 0, 0));
      this.collider(s * (2.1 + 6.0), 0, 28.0, 6.1, 1.8, 1.8);
    }
    B.build(this.zvezda);
    this.group.add(this.zvezda);
  }

  addDynamic(chain, localBox) {
    const collider = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this.colliders.push(collider);
    this.dynamic.push({ chain, localBox, collider });
  }

  refreshDynamicColliders() {
    const m = new THREE.Matrix4();
    const box = new THREE.Box3();
    for (const d of this.dynamic) {
      m.identity();
      for (const node of d.chain) {
        node.updateMatrix();
        m.multiply(node.matrix);
      }
      box.copy(d.localBox).applyMatrix4(m);
      d.collider.min.copy(box.min);
      d.collider.max.copy(box.max);
    }
  }

  // ---------------------------------------------------------------- lights
  buildLights() {
    const glow = radialGlowTexture([
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,255,255,0.7)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    const add = (color, x, y, z, phase, size = 0.9) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      s.position.set(x, y, z);
      s.scale.setScalar(size);
      this.group.add(s);
      this.lights.push({ s, phase, color: new THREE.Color(color) });
    };
    add(0xff2a2a, -54.0, TRUSS_Y, TRUSS_Z, 0); // port: red
    add(0x2aff4a, 54.0, TRUSS_Y, TRUSS_Z, 0); // starboard: green
    add(0xffffff, 0, 0, 36.6, 0.5); // aft strobe (cargo vehicle)
    add(0xffffff, 0, -15.8, 20.1, 0.9); // nadir strobe
    add(0xffffff, 0, 2.6, -17.6, 0.25); // Harmony forward strobe
    const pz = ISS_PORT_LOCAL.z;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      add(0xa8d4ff, Math.cos(a) * 1.25, Math.sin(a) * 1.25, pz + 0.6, -1, 0.45); // steady approach lights
    }
  }

  /**
   * @param time seconds
   * @param sunDirStation unit vector toward the Sun in the station frame
   */
  update(time, sunDirStation) {
    this.time = time;
    const s = sunDirStation;
    // alpha (SARJ): rotate wing normal (+Z in the alpha frame) into the sun's Y-Z projection
    const alpha = Math.atan2(-s.y, s.z);
    for (const g of this.alpha) g.rotation.x = alpha;
    if (this.zvezda) this.zvezda.rotation.x = Math.atan2(s.z, s.y); // Zvezda panel normal is +Y
    // beta: tilt about the wing's long axis toward the out-of-plane sun component
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    const sz = -sa * s.y + ca * s.z; // sun z in the alpha frame
    const beta = Math.atan2(s.x, sz);
    const betaClamped = Math.max(-1.3, Math.min(1.3, beta));
    for (const b of this.betas) b.rotation.y = betaClamped;
    this.refreshDynamicColliders();
    for (const l of this.lights) {
      const m = l.s.material;
      if (l.phase < 0) {
        m.color.copy(l.color).multiplyScalar(2.5);
        m.opacity = 0.9;
        continue;
      }
      const on = (time + l.phase) % 1.6 < 0.14;
      m.opacity = on ? 1 : 0.05;
      m.color.copy(l.color).multiplyScalar(on ? 8 : 1);
    }
  }
}
