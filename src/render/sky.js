// Star field, baked Milky Way background and the Sun.
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.glsl.js';
import { radialGlowTexture } from './textures.js';

const MW_FRAG = /* glsl */ `
${NOISE_GLSL}
varying vec3 vDir;
uniform vec3 uPole;
uniform vec3 uCenter;
void main() {
  vec3 d = normalize(vDir);
  float b = asin(clamp(dot(d, uPole), -1.0, 1.0));
  vec3 side = cross(uPole, uCenter);
  float l = atan(dot(d, side), dot(d, uCenter));
  float warpB = b + 0.04 * fbm(d * 3.0, 4);
  float band = exp(-pow(warpB / 0.17, 2.0));
  float bulge = exp(-pow(b / 0.22, 2.0)) * exp(-pow(l / 0.55, 2.0));
  float n = 0.5 + 0.5 * fbm(d * 5.0 + vec3(3.0), 7);
  float clumps = 0.5 + 0.5 * fbm(d * 18.0, 5);
  float dust = smoothstep(0.42, 0.8, 0.5 + 0.5 * fbm(d * 6.5 + vec3(7.0), 7)) * exp(-pow((b - 0.02) / 0.07, 2.0));
  vec3 col = vec3(0.62, 0.7, 1.0) * band * (0.25 + 0.9 * n * clumps);
  col += vec3(1.0, 0.82, 0.58) * bulge * (0.9 + 0.6 * n);
  col *= 1.0 - dust * 0.9;
  // faint nebulae
  float neb = smoothstep(0.55, 0.9, 0.5 + 0.5 * fbm(d * 3.0 + vec3(19.0), 5)) * band;
  col += vec3(0.9, 0.25, 0.35) * neb * 0.25;
  // unresolved star haze
  float haze = pow(max(snoise(d * 700.0), 0.0), 10.0) * (0.3 + band * 2.0);
  col += vec3(haze);
  col += vec3(0.05, 0.06, 0.1) * (0.5 + 0.5 * fbm(d * 2.0, 3)) * 0.4;
  gl_FragColor = vec4(col * 0.5, 1.0);
}
`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
varying vec3 vColor;
uniform float uPixelRatio;
uniform float uBrightness;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vColor = aColor * uBrightness;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio;
  #include <logdepthbuf_vertex>
}
`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = exp(-r * r * 5.0);
  gl_FragColor = vec4(vColor * a, a);
}
`;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function starColor(tempK) {
  // approximate blackbody → RGB
  const t = tempK / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (x) => Math.min(255, Math.max(0, x)) / 255;
  return new THREE.Color(c(r), c(g), c(b)).convertSRGBToLinear();
}

export class Sky {
  constructor(renderer, scene, { quality = 'high' } = {}) {
    this.pole = new THREE.Vector3(0.35, 0.78, -0.52).normalize();
    this.center = new THREE.Vector3(1, 0, 0).sub(this.pole.clone().multiplyScalar(this.pole.x)).normalize();
    // ---- Milky Way bake ----
    const size = quality === 'low' ? 512 : 1024;
    const rt = new THREE.WebGLCubeRenderTarget(size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const bakeScene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} ',
      fragmentShader: MW_FRAG,
      uniforms: { uPole: { value: this.pole }, uCenter: { value: this.center } },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    bakeScene.add(box);
    const tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    new THREE.CubeCamera(0.1, 10, rt).update(renderer, bakeScene);
    renderer.toneMapping = tm;
    mat.dispose();
    box.geometry.dispose();
    this.background = rt.texture;
    scene.background = rt.texture;
    scene.backgroundIntensity = 0.5;

    // ---- stars ----
    const N = quality === 'low' ? 4000 : 9000;
    const r = rng(42);
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const sz = new Float32Array(N);
    const R = 1e10;
    const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      // 45% concentrated toward galactic plane
      do {
        v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      } while (v.lengthSq() > 1 || v.lengthSq() < 1e-4);
      v.normalize();
      if (r() < 0.45) {
        const b = v.dot(this.pole);
        v.addScaledVector(this.pole, -b * 0.8).normalize();
      }
      pos[i * 3] = v.x * R;
      pos[i * 3 + 1] = v.y * R;
      pos[i * 3 + 2] = v.z * R;
      // magnitude distribution: many faint, few bright
      const mag = -1.2 + 7.6 * Math.pow(r(), 0.45);
      const flux = Math.pow(10, -0.4 * mag);
      const temp = 2800 + Math.pow(r(), 1.8) * 18000;
      const c = starColor(temp);
      const bright = Math.min(6, 0.25 + flux * 4.0);
      col[i * 3] = c.r * bright;
      col[i * 3 + 1] = c.g * bright;
      col[i * 3 + 2] = c.b * bright;
      sz[i] = 1.6 + Math.min(5.5, Math.sqrt(flux) * 4.5);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    this.starUniforms = { uPixelRatio: { value: renderer.getPixelRatio() }, uBrightness: { value: 1 } };
    this.stars = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: this.starUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -10;
    scene.add(this.stars);

    // ---- sun ----
    const disk = radialGlowTexture([
      [0, 'rgba(255,255,255,1)'],
      [0.42, 'rgba(255,255,250,1)'],
      [0.5, 'rgba(255,245,230,0.25)'],
      [0.7, 'rgba(255,230,200,0.03)'],
      [1, 'rgba(255,220,180,0)'],
    ]);
    this.sun = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: disk, color: new THREE.Color(40, 37, 33), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.sun.renderOrder = -8;
    this.sun.frustumCulled = false;
    scene.add(this.sun);
    this.sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialGlowTexture(),
        color: new THREE.Color(0.5, 0.45, 0.4),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.sunGlow.renderOrder = -8;
    this.sunGlow.frustumCulled = false;
    scene.add(this.sunGlow);
    this.sunDistance = 1e10;
  }

  update(sunDir, eclipse, pixelRatio) {
    const d = this.sunDistance;
    this.sun.position.copy(sunDir).multiplyScalar(d);
    this.sun.scale.setScalar(d * 0.0093 * 2.2); // disk = 0.53 deg (inner ~45% of sprite)
    this.sunGlow.position.copy(this.sun.position);
    this.sunGlow.scale.setScalar(d * 0.16);
    this.sunGlow.material.opacity = 0.35;
    // stars are washed out when the sunlit scene dominates the exposure
    this.starUniforms.uBrightness.value = 0.35 + 0.65 * eclipse;
    this.starUniforms.uPixelRatio.value = pixelRatio;
  }
}
