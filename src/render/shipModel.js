// Procedural crew capsule + service module with PBR materials, engine plume,
// RCS jets, re-entry plasma sheath and parachutes. Body frame: forward = -Z.
import * as THREE from 'three';
import { panelTexture, solarCellTexture, foilNormalTexture, radialGlowTexture } from './textures.js';

let shared = null;
function sharedAssets() {
  if (shared) return shared;
  const panel = panelTexture('#dfe0e2', '#8f9296', 3, 10);
  const smPanel = panelTexture('#e9e9ea', '#a2a4a8', 9, 6);
  const foil = foilNormalTexture(5);
  foil.repeat.set(6, 1);
  const cells = solarCellTexture();
  cells.repeat.set(1, 3);
  const glow = radialGlowTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(200,220,255,0.5)'],
    [1, 'rgba(150,180,255,0)'],
  ]);
  shared = {
    hull: new THREE.MeshPhysicalMaterial({
      color: 0xd4d6da,
      map: panel,
      roughness: 0.55,
      metalness: 0.05,
      clearcoat: 0.08,
      clearcoatRoughness: 0.6,
      envMapIntensity: 0.35,
    }),
    sm: new THREE.MeshStandardMaterial({ color: 0xffffff, map: smPanel, roughness: 0.5, metalness: 0.2 }),
    gold: new THREE.MeshPhysicalMaterial({
      color: 0xd9a441,
      metalness: 1,
      roughness: 0.28,
      normalMap: foil,
      normalScale: new THREE.Vector2(0.9, 0.9),
    }),
    silverFoil: new THREE.MeshPhysicalMaterial({
      color: 0xc9ccd2,
      metalness: 1,
      roughness: 0.38,
      envMapIntensity: 0.6,
      normalMap: foil,
      normalScale: new THREE.Vector2(0.7, 0.7),
    }),
    shield: new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.95, metalness: 0.0, emissive: new THREE.Color(0xff5a14), emissiveIntensity: 0 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.7 }),
    nozzle: new THREE.MeshStandardMaterial({
      color: 0x55504c,
      roughness: 0.35,
      metalness: 0.9,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(0xff5a1a),
      emissiveIntensity: 0,
    }),
    window: new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.05, metalness: 0.0, clearcoat: 1 }),
    solar: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: cells,
      roughness: 0.25,
      metalness: 0.4,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      side: THREE.DoubleSide,
    }),
    port: new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.35, metalness: 0.85 }),
    glow,
  };
  return shared;
}

function cyl(rTop, rBot, len, seg, mat, z, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
  g.rotateX(-Math.PI / 2); // +Y -> -Z (radiusTop at the front)
  const m = new THREE.Mesh(g, mat);
  m.position.z = z;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const PLUME_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormalV;
varying vec3 vViewDir;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vPos = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;
const PLUME_FRAG = /* glsl */ `
uniform float uTime;
uniform float uThrottle;
uniform float uLength;
uniform float uVacuum;
varying vec3 vPos;
varying vec3 vNormalV;
varying vec3 vViewDir;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float s = clamp(vPos.z / uLength, 0.0, 1.0); // 0 at nozzle, 1 at tail
  float rim = abs(dot(vNormalV, vViewDir));
  float core = pow(rim, 2.5);
  float flicker = 0.85 + 0.15 * sin(uTime * 63.0 + vPos.z * 3.0) * sin(uTime * 41.0 - vPos.z * 1.7);
  float diamonds = 0.75 + 0.25 * cos(vPos.z * 2.2 - uTime * 2.0) * (1.0 - uVacuum);
  float fade = pow(1.0 - s, 1.6 + uVacuum);
  vec3 hot = vec3(0.75, 0.82, 1.0);
  vec3 warm = vec3(1.0, 0.55, 0.22);
  vec3 col = mix(hot, warm, smoothstep(0.0, 0.5, s));
  float a = core * fade * flicker * diamonds * uThrottle;
  gl_FragColor = vec4(col * a * 1.1, a * 0.6);
}
`;

const PLASMA_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying vec3 vPos;
varying vec3 vNormalV;
varying vec3 vViewDir;
#include <logdepthbuf_pars_fragment>
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  #include <logdepthbuf_fragment>
  float rim = 1.0 - abs(dot(vNormalV, vViewDir));
  float front = smoothstep(-8.0, 4.0, vPos.z); // brighter toward the leading (shield) side
  float n = 0.85 + 0.15 * sin(uTime * 37.0 + vPos.z * 2.3) * sin(uTime * 23.0 - vPos.z * 1.1);
  float a = pow(rim, 1.6) * (0.3 + 0.7 * front) * n * uIntensity * 1.3;
  vec3 col = mix(vec3(1.0, 0.42, 0.15), vec3(1.0, 0.6, 0.95), rim * 0.5);
  gl_FragColor = vec4(col * a * 3.2, a);
}
`;

function makeChute(radius, lineLength, color1, color2, gores = 12) {
  // Local origin = attachment point at the capsule nose; canopy trails toward -Z.
  const group = new THREE.Group();
  const theta = Math.PI * 0.42;
  const geo = new THREE.SphereGeometry(radius, gores * 2, 10, 0, Math.PI * 2, 0, theta);
  const colors = [];
  const pos = geo.attributes.position;
  const c1 = new THREE.Color(color1);
  const c2 = new THREE.Color(color2);
  for (let i = 0; i < pos.count; i++) {
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    const k = Math.floor(((a + Math.PI) / (Math.PI * 2)) * gores) % 2;
    const c = k ? c1 : c2;
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.rotateX(-Math.PI / 2); // apex toward -Z, rim at z = -R cos(theta)
  const rimZ = -(lineLength + radius * Math.cos(theta));
  geo.translate(0, 0, -lineLength);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
  const canopy = new THREE.Mesh(geo, mat);
  canopy.castShadow = true;
  group.add(canopy);
  const verts = [];
  const rimR = radius * Math.sin(theta);
  for (let k = 0; k < gores; k++) {
    const a = (k / gores) * Math.PI * 2;
    verts.push(0, 0, 0, Math.cos(a) * rimR, Math.sin(a) * rimR, rimZ);
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xcfcfcf, transparent: true, opacity: 0.55 })));
  return group;
}

export class ShipModel {
  constructor({ tint = null } = {}) {
    const A = sharedAssets();
    const hullMat = tint ? A.hull.clone() : A.hull;
    if (tint) hullMat.color = new THREE.Color(tint);
    this.group = new THREE.Group();
    const g = this.group;

    // ---- capsule (crew module) ----
    const capsule = new THREE.Group();
    capsule.add(cyl(0.85, 2.5, 3.3, 64, hullMat, -0.95));
    // heat shield
    const shield = cyl(2.5, 2.42, 0.28, 64, A.shield, 0.84);
    capsule.add(shield);
    const capGeo = new THREE.SphereGeometry(6.5, 64, 6, 0, Math.PI * 2, 0, Math.asin(2.42 / 6.5));
    capGeo.rotateX(Math.PI / 2);
    const cap = new THREE.Mesh(capGeo, A.shield);
    cap.position.z = 0.98 - 6.5 * Math.cos(Math.asin(2.42 / 6.5)) - 0.0;
    cap.castShadow = true;
    capsule.add(cap);
    // docking port & forward bay
    capsule.add(cyl(0.62, 0.85, 0.35, 32, A.silverFoil, -2.77));
    capsule.add(cyl(0.55, 0.58, 0.3, 32, A.port, -2.9));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.05, 12, 48), A.port);
    ring.position.z = -3.04;
    capsule.add(ring);
    for (let k = 0; k < 3; k++) {
      const petal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.18), A.port);
      const a = (k / 3) * Math.PI * 2 + 0.3;
      petal.position.set(Math.cos(a) * 0.42, Math.sin(a) * 0.42, -3.1);
      petal.rotation.z = a;
      capsule.add(petal);
    }
    // windows
    const slope = Math.atan((2.5 - 0.85) / 3.3);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const z = -1.6;
      const rr = 0.85 + ((z + 2.6) / 3.3) * 1.65 + 0.01;
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.34), A.window);
      const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      const normal = radial.clone().multiplyScalar(Math.cos(slope)).add(new THREE.Vector3(0, 0, -Math.sin(slope)));
      w.position.copy(radial.multiplyScalar(rr)).setZ(z);
      w.lookAt(w.position.clone().add(normal));
      capsule.add(w);
    }
    g.add(capsule);
    this.capsule = capsule;

    // capsule RCS quads (at 4 positions around base)
    this.nozzles = [];
    const glowMat = new THREE.SpriteMaterial({
      map: A.glow,
      color: 0xdde8ff,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      const tangent = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0);
      const base = radial.clone().multiplyScalar(2.05).setZ(0.15);
      const quad = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), A.dark);
      quad.position.copy(base);
      g.add(quad);
      const dirs = [radial, tangent, tangent.clone().negate(), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
      for (const d of dirs) {
        const s = new THREE.Sprite(glowMat.clone());
        s.position.copy(base).addScaledVector(d, 0.45);
        s.scale.setScalar(0.001);
        s.visible = false;
        g.add(s);
        this.nozzles.push({ sprite: s, pos: base.clone(), dir: d.clone() });
      }
    }

    // ---- service module ----
    const sm = new THREE.Group();
    sm.add(cyl(2.48, 2.48, 0.25, 64, A.dark, 1.1));
    sm.add(cyl(2.45, 2.45, 3.8, 64, A.sm, 3.1));
    const band = cyl(2.47, 2.47, 1.1, 64, A.gold, 1.8, true);
    sm.add(band);
    sm.add(cyl(2.45, 1.4, 0.5, 48, A.silverFoil, 5.25));
    // engine bell
    const pts = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      pts.push(new THREE.Vector2(0.34 + 0.72 * Math.pow(t, 0.62), t * 1.9));
    }
    const bellGeo = new THREE.LatheGeometry(pts, 48);
    bellGeo.rotateX(Math.PI / 2); // lathe axis +Y -> +Z
    const bell = new THREE.Mesh(bellGeo, A.nozzle);
    bell.position.z = 5.45;
    bell.castShadow = true;
    sm.add(bell);
    this.bell = bell;
    // radiators + solar arrays (4 wings, X-pattern)
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const wing = new THREE.Group();
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.12), A.dark);
      arm.position.x = 2.9;
      wing.add(arm);
      for (let p = 0; p < 3; p++) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.04, 2.0), A.solar);
        panel.position.x = 4.55 + p * 2.3;
        panel.castShadow = true;
        panel.receiveShadow = true;
        wing.add(panel);
      }
      wing.rotation.z = a;
      wing.position.z = 4.1;
      sm.add(wing);
    }
    for (let k = 0; k < 2; k++) {
      const rad = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.8, 2.6), A.sm);
      rad.position.set(k ? 2.47 : -2.47, 0, 3.4);
      sm.add(rad);
    }
    g.add(sm);
    this.sm = sm;

    // ---- engine plume ----
    this.plumeUniforms = {
      uTime: { value: 0 },
      uThrottle: { value: 0 },
      uLength: { value: 16 },
      uVacuum: { value: 1 },
    };
    const plumeGeo = new THREE.CylinderGeometry(1.0, 4.2, 16, 32, 24, true);
    plumeGeo.rotateX(Math.PI / 2); // +Y -> +Z ... radiusTop now at +Z: flip so narrow end at nozzle
    plumeGeo.translate(0, 0, 8);
    // after rotateX(+pi/2) radiusTop (1.0) is at +Z end; we want narrow at nozzle (z=0)
    plumeGeo.scale(1, 1, -1);
    plumeGeo.translate(0, 0, 16);
    const plumeMat = new THREE.ShaderMaterial({
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      uniforms: this.plumeUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.plume = new THREE.Mesh(plumeGeo, plumeMat);
    this.plume.position.z = 7.25;
    this.plume.visible = false;
    this.plume.renderOrder = 5;
    sm.add(this.plume);
    this.engineLight = new THREE.PointLight(0xffa060, 0, 60, 2);
    this.engineLight.position.z = 8;
    sm.add(this.engineLight);

    // ---- plasma sheath ----
    this.plasmaUniforms = { uTime: { value: 0 }, uIntensity: { value: 0 } };
    const plasmaGeo = new THREE.SphereGeometry(1, 48, 24);
    plasmaGeo.scale(3.4, 3.4, 7.5);
    plasmaGeo.translate(0, 0, -3.2); // trails behind the vehicle (toward -Z in sheath frame)
    this.plasma = new THREE.Mesh(
      plasmaGeo,
      new THREE.ShaderMaterial({
        vertexShader: PLUME_VERT,
        fragmentShader: PLASMA_FRAG,
        uniforms: this.plasmaUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.plasma.visible = false;
    this.plasma.renderOrder = 6;

    // ---- parachutes ----
    this.drogues = [makeChute(3.2, 20, 0xff6a13, 0xffffff, 10), makeChute(3.2, 20, 0xff6a13, 0xffffff, 10)];
    this.mains = [
      makeChute(17, 40, 0xff5a10, 0xf4f4f4, 16),
      makeChute(17, 40, 0xf4f4f4, 0xff5a10, 16),
      makeChute(17, 40, 0xff5a10, 0xf4f4f4, 16),
    ];
    this.drogues.forEach((c, i) => {
      c.position.z = -3.05;
      c.rotation.y = i ? 0.12 : -0.12;
    });
    this.mains.forEach((c, i) => {
      const a = (i / 3) * Math.PI * 2;
      c.position.z = -3.05;
      c.rotation.set(Math.sin(a) * 0.36, -Math.cos(a) * 0.36, 0);
    });
    for (const c of [...this.drogues, ...this.mains]) {
      c.visible = false;
      g.add(c);
    }

    g.traverse((o) => {
      if (o.isMesh && o !== this.plume) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.plume.castShadow = false;
  }

  /** Detached service module (for the jettison animation). */
  detachServiceModule() {
    this.sm.visible = false;
    const clone = this.sm.clone(true);
    clone.visible = true;
    clone.traverse((o) => {
      if (o === this.plume || o.isPointLight) o.visible = false;
    });
    return clone;
  }

  /** Update visual effects from the spacecraft state. */
  update(ship, time, dt) {
    this.sm.visible = ship.stage === 0;
    // plume
    const th = ship.thrustActive ? ship.throttle : 0;
    const vac = Math.min(1, Math.max(0, ship.altitude / 60000));
    this.plume.visible = th > 0.001;
    this.plumeUniforms.uTime.value = time;
    this.plumeUniforms.uThrottle.value = th;
    this.plumeUniforms.uVacuum.value = vac;
    this.plume.scale.set(0.7 + vac * 0.6, 0.7 + vac * 0.6, 0.5 + th * 0.7);
    this.engineLight.intensity = th * 250;
    this.bell.material.emissiveIntensity = th * 1.4;

    // RCS jets
    const rot = ship.rotCmd;
    const tr = ship.transCmd;
    const torque = new THREE.Vector3();
    for (const n of this.nozzles) {
      const thrust = n.dir.clone().negate();
      let level = Math.max(0, thrust.dot(tr));
      torque.crossVectors(n.pos, thrust).normalize();
      level += Math.max(0, torque.x * rot.x + torque.y * rot.y + torque.z * rot.z) * 0.8;
      level = Math.min(1, level);
      const on = level > 0.15 && ship.rcsEnabled && ship.rcsFuel > 0;
      n.sprite.visible = on;
      if (on) {
        const s = 0.5 + level * 0.9 * (0.8 + Math.random() * 0.4);
        n.sprite.scale.setScalar(s);
        n.sprite.material.opacity = 0.55 * level;
      }
    }

    // chutes
    const dep = Math.min(1, ship.chuteDeploy);
    const showD = ship.chute === 'drogue';
    const showM = ship.chute === 'main';
    this.drogues.forEach((c) => {
      c.visible = showD;
      if (showD) {
        const s = 0.15 + 0.85 * dep;
        c.scale.set(s, s, 0.4 + 0.6 * dep);
      }
    });
    this.mains.forEach((c) => {
      c.visible = showM;
      if (showM) {
        const s = 0.08 + 0.92 * dep * dep;
        c.scale.set(s, s, 0.3 + 0.7 * dep);
      }
    });

    // plasma
    const pi = Math.min(1.4, ship.heatFlux / 5e5);
    this.plasma.visible = pi > 0.02;
    sharedAssets().shield.emissiveIntensity = Math.min(3, ship.heatFlux / 2e5);
    this.plasmaUniforms.uIntensity.value = pi;
    this.plasmaUniforms.uTime.value = time;
  }
}
