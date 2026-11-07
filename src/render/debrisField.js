// Orbital debris & satellite population (map view) propagated on the GPU, plus
// a tumbling fragment model for close encounters.
import * as THREE from 'three';
import { MU, R_EARTH } from '../sim/constants.js';

const DEG = Math.PI / 180;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
}

// Shells loosely based on the public catalogue distribution (alt km, inc deg).
const SHELLS = [
  { w: 0.28, alt: 550, altSd: 8, inc: 53, incSd: 0.2, sat: true }, // large LEO constellation
  { w: 0.06, alt: 540, altSd: 6, inc: 43, incSd: 0.2, sat: true },
  { w: 0.04, alt: 570, altSd: 6, inc: 70, incSd: 0.2, sat: true },
  { w: 0.04, alt: 560, altSd: 6, inc: 97.6, incSd: 0.2, sat: true },
  { w: 0.04, alt: 1200, altSd: 10, inc: 87.9, incSd: 0.2, sat: true }, // polar LEO constellation
  { w: 0.14, alt: 720, altSd: 120, inc: 98.2, incSd: 0.6, sat: true }, // sun-synchronous
  { w: 0.12, alt: 850, altSd: 180, inc: 98.6, incSd: 1.5, sat: false }, // 2007 ASAT test cloud
  { w: 0.06, alt: 790, altSd: 120, inc: 74, incSd: 1.2, sat: false }, // 2009 collision cloud (A)
  { w: 0.03, alt: 780, altSd: 110, inc: 86.4, incSd: 1.0, sat: false }, // 2009 collision cloud (B)
  { w: 0.07, alt: 480, altSd: 160, inc: 65, incSd: 25, sat: false }, // general LEO debris
  { w: 0.04, alt: 900, altSd: 300, inc: 82, incSd: 12, sat: false },
  { w: 0.01, alt: 415, altSd: 15, inc: 51.6, incSd: 0.3, sat: false }, // near the station orbit
  { w: 0.025, alt: 20200, altSd: 50, inc: 55, incSd: 1, sat: true }, // GNSS
  { w: 0.01, alt: 19100, altSd: 50, inc: 64.8, incSd: 1, sat: true },
  { w: 0.035, alt: 35786, altSd: 30, inc: 0.05, incSd: 1.5, sat: true }, // geostationary ring
];

const VERT = /* glsl */ `
attribute vec4 aOrbit; // a (m), i, raan, u0
attribute float aKind;  // 0 debris, 1 satellite
uniform float uTime;
uniform vec3 uCenter;   // Earth centre relative to camera
uniform float uPixelRatio;
uniform float uMu;
varying vec3 vColor;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  float a = aOrbit.x;
  float n = sqrt(uMu / (a * a * a));
  float u = aOrbit.w + n * uTime;
  vec3 N = vec3(cos(aOrbit.z), 0.0, -sin(aOrbit.z));
  // rotate +Y about N by inclination (Rodrigues)
  vec3 Y = vec3(0.0, 1.0, 0.0);
  float ci = cos(aOrbit.y), si = sin(aOrbit.y);
  vec3 h = Y * ci + cross(N, Y) * si + N * dot(N, Y) * (1.0 - ci);
  vec3 Q = cross(h, N);
  vec3 p = a * (cos(u) * N + sin(u) * Q);
  vec4 mv = modelViewMatrix * vec4(p + uCenter, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (aKind > 0.5 ? 2.4 : 1.8) * uPixelRatio;
  vColor = aKind > 0.5 ? vec3(0.65, 0.85, 1.0) : vec3(1.0, 0.45, 0.25);
  #include <logdepthbuf_vertex>
}
`;
const FRAG = /* glsl */ `
varying vec3 vColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.2, length(c));
  gl_FragColor = vec4(vColor * a * 0.9, a * 0.9);
}
`;

export class DebrisPopulation {
  constructor(count = 12000) {
    const r = rng(1957);
    const orbit = new Float32Array(count * 4);
    const kind = new Float32Array(count);
    const total = SHELLS.reduce((s, x) => s + x.w, 0);
    for (let k = 0; k < count; k++) {
      let pick = r() * total;
      let sh = SHELLS[0];
      for (const s of SHELLS) {
        pick -= s.w;
        if (pick <= 0) {
          sh = s;
          break;
        }
      }
      const alt = Math.max(250, sh.alt + gauss(r) * sh.altSd);
      orbit[k * 4] = (R_EARTH + alt * 1000);
      orbit[k * 4 + 1] = Math.max(0, sh.inc + gauss(r) * sh.incSd) * DEG;
      orbit[k * 4 + 2] = r() * Math.PI * 2;
      orbit[k * 4 + 3] = r() * Math.PI * 2;
      kind[k] = sh.sat && r() < 0.85 ? 1 : 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uPixelRatio: { value: 1 },
      uMu: { value: MU },
    };
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this.points.visible = false;
    this.count = count;
  }

  update(simTime, origin, pixelRatio, visible) {
    this.points.visible = visible;
    if (!visible) return;
    // keep the float argument small: wrap time to a multiple of a long period
    this.uniforms.uTime.value = simTime % 864000;
    this.uniforms.uCenter.value.set(-origin.x, -origin.y, -origin.z);
    this.uniforms.uPixelRatio.value = pixelRatio;
  }
}

/** A tumbling debris fragment (piece of a spent upper stage + shards). */
export function makeFragmentModel(seed = 7) {
  const r = rng(seed);
  const group = new THREE.Group();
  const body = new THREE.CylinderGeometry(1.2, 1.2, 3.2, 20, 6, true);
  const pos = body.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const crumple = 0.25 * Math.sin(y * 3.1 + pos.getX(i) * 2.0) * (y > 0.8 ? 1.6 : 0.6);
    pos.setX(i, pos.getX(i) * (1 + crumple * (r() - 0.3)));
    pos.setZ(i, pos.getZ(i) * (1 + crumple * (r() - 0.3)));
    if (y > 1.2) pos.setY(i, y - r() * 0.8);
  }
  body.computeVertexNormals();
  const metal = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, metalness: 0.8, roughness: 0.45, side: THREE.DoubleSide });
  const foam = new THREE.MeshStandardMaterial({ color: 0xc8662a, roughness: 0.9, side: THREE.DoubleSide });
  group.add(new THREE.Mesh(body, metal));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.08, 8, 24), metal);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -1.6;
  group.add(ring);
  for (let k = 0; k < 6; k++) {
    const shard = new THREE.Mesh(new THREE.BoxGeometry(0.3 + r() * 0.9, 0.04, 0.2 + r() * 0.6), k % 2 ? foam : metal);
    shard.position.set((r() - 0.5) * 6, (r() - 0.5) * 6, (r() - 0.5) * 6);
    shard.rotation.set(r() * 6, r() * 6, r() * 6);
    group.add(shard);
  }
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // glint so the object is visible as a point of light from afar
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,220,1)');
  grad.addColorStop(0.3, 'rgba(255,180,120,0.35)');
  grad.addColorStop(1, 'rgba(255,160,100,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const glint = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), color: new THREE.Color(3, 2.6, 2.2), blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false }),
  );
  glint.scale.setScalar(0.02);
  group.add(glint);
  group.userData.glint = glint;
  return group;
}
