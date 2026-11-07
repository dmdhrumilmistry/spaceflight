// Procedural Earth: surface/cloud/height maps are baked once into cube maps on
// the GPU, then a single ray-traced shader renders ground, ocean glint, city
// lights, a cloud layer and physically based single-scattering atmosphere
// (Rayleigh + Mie) with correct per-pixel depth (log depth buffer).
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.glsl.js';
import { R_EARTH, ATMO_VISUAL_HEIGHT, CLOUD_HEIGHT, EARTH_ROT } from '../sim/constants.js';

const TERRAIN_GLSL = /* glsl */ `
uniform float uSeed;
float terrain(vec3 p, out float mountains, out vec3 warp) {
  vec3 q = p + vec3(uSeed * 1.37, uSeed * 0.71, uSeed * 2.13);
  warp = vec3(fbm(q * 1.1 + vec3(0.0, 3.1, 7.4), 4),
              fbm(q * 1.1 + vec3(5.2, 1.3, 2.8), 4),
              fbm(q * 1.1 + vec3(9.1, 4.7, 0.6), 4));
  float c = fbm(q * 1.3 + warp * 0.9, 8);
  c += 0.10 * fbm(q * 4.7 + warp * 1.7, 6);
  float m = ridged(q * 3.4 + warp * 1.3, 8);
  mountains = m * smoothstep(0.03, 0.2, c);
  return c + mountains * 0.22;
}
`;

const BAKE_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Land albedo (sqrt-encoded) + city lights
const BAKE_SURFACE_FRAG = /* glsl */ `
${NOISE_GLSL}
${TERRAIN_GLSL}
uniform float uSea;
varying vec3 vDir;
void main() {
  vec3 p = normalize(vDir);
  float m; vec3 w;
  float h = terrain(p, m, w);
  float lat = abs(p.y);
  float e = max(h - uSea, 0.0);
  float temp = 1.0 - pow(lat, 1.35) * 1.15 - e * 1.5 + 0.09 * fbm(p * 6.0 + w, 4);
  float moist = 0.6 + 0.6 * fbm(p * 2.3 + vec3(11.0), 5);
  float desertBelt = exp(-pow((lat - 0.42) / 0.15, 2.0));
  moist -= desertBelt * 0.38;
  moist += exp(-pow(lat / 0.16, 2.0)) * 0.25;
  moist += 0.25 * exp(-e * 12.0) - 0.1; // coasts are wetter

  vec3 forest = vec3(0.030, 0.062, 0.022);
  vec3 jungle = vec3(0.020, 0.052, 0.016);
  vec3 grass  = vec3(0.090, 0.105, 0.045);
  vec3 steppe = vec3(0.17, 0.15, 0.085);
  vec3 desert = vec3(0.50, 0.37, 0.21);
  vec3 redSand = vec3(0.43, 0.23, 0.11);
  vec3 tundra = vec3(0.12, 0.115, 0.09);
  vec3 rock   = vec3(0.15, 0.125, 0.105);
  vec3 snow   = vec3(0.86, 0.88, 0.92);

  vec3 dry = mix(desert, redSand, smoothstep(-0.25, 0.45, fbm(p * 7.0 + w * 2.0, 4)));
  dry = mix(dry, steppe, smoothstep(0.15, 0.35, moist));
  vec3 veg = mix(grass, forest, smoothstep(0.45, 0.7, moist));
  veg = mix(veg, jungle, smoothstep(0.8, 0.98, temp) * smoothstep(0.5, 0.7, moist));
  vec3 col = mix(dry, veg, smoothstep(0.32, 0.52, moist));
  col = mix(tundra, col, smoothstep(0.12, 0.34, temp));
  col = mix(col, rock, smoothstep(0.25, 0.65, m));
  col = mix(col, snow, smoothstep(0.04, -0.07, temp));
  col *= 0.82 + 0.36 * (0.5 + 0.5 * fbm(p * 38.0 + w * 3.0, 4));

  // city lights: population clusters near coasts in temperate zones
  float pop = smoothstep(0.05, 0.45, fbm(p * 3.1 + vec3(21.0), 4));
  pop *= (1.0 - desertBelt * 0.65) * smoothstep(0.05, 0.3, temp) * smoothstep(-0.02, 0.02, h - uSea);
  pop *= 0.45 + exp(-e * 18.0);
  float cities = pow(max(0.0, snoise(p * 95.0)), 2.0) * 1.4 + pow(max(0.0, snoise(p * 280.0 + w)), 3.0) * 1.2;
  float lights = clamp(pop * cities * 1.6, 0.0, 1.0);

  gl_FragColor = vec4(sqrt(clamp(col, 0.0, 1.0)), lights);
}
`;

// Clouds (R), spare (G), height (B, float), mountains (A)
const BAKE_AUX_FRAG = /* glsl */ `
${NOISE_GLSL}
${TERRAIN_GLSL}
varying vec3 vDir;
void main() {
  vec3 p = normalize(vDir);
  float m; vec3 w;
  float h = terrain(p, m, w);
  float lat = abs(p.y);
  vec3 q = p * 2.4 + vec3(40.0);
  vec3 w2 = vec3(fbm(q + vec3(1.0, 2.0, 3.0), 5), fbm(q + vec3(7.0, 3.0, 1.0), 5), fbm(q + vec3(3.0, 8.0, 5.0), 5));
  // latitude-dependent stretching mimics zonal winds
  vec3 qs = vec3(p.x * 2.2, p.y * 4.2, p.z * 2.2) + w2 * 1.6;
  float c = fbm(qs * 1.6 + vec3(13.0), 9);
  float band = 0.16 * exp(-pow(lat / 0.11, 2.0)) + 0.2 * exp(-pow((lat - 0.78) / 0.13, 2.0)) - 0.14 * exp(-pow((lat - 0.42) / 0.12, 2.0));
  float cov = smoothstep(0.02, 0.42, c + band + 0.02);
  cov *= 0.55 + 0.45 * smoothstep(-0.3, 0.5, fbm(p * 16.0 + w2 * 2.0, 6));
  gl_FragColor = vec4(cov, 0.0, h, m);
}
`;

function makeBakeTarget(size, type) {
  const rt = new THREE.WebGLCubeRenderTarget(size, {
    type,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.anisotropy = 8;
  return rt;
}

export function bakeEarthMaps(renderer, { size = 1024, seed = 3.0, sea = 0.06 } = {}) {
  const scene = new THREE.Scene();
  const geo = new THREE.BoxGeometry(2, 2, 2);
  const uniforms = { uSeed: { value: seed }, uSea: { value: sea } };
  const surfMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_SURFACE_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const auxMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_AUX_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, surfMat);
  scene.add(mesh);

  const surfaceRT = makeBakeTarget(size, THREE.UnsignedByteType);
  const auxRT = makeBakeTarget(Math.max(256, size / 2), THREE.HalfFloatType);

  const prevToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  const cam1 = new THREE.CubeCamera(0.1, 10, surfaceRT);
  cam1.update(renderer, scene);
  mesh.material = auxMat;
  const cam2 = new THREE.CubeCamera(0.1, 10, auxRT);
  cam2.update(renderer, scene);
  renderer.toneMapping = prevToneMapping;

  geo.dispose();
  surfMat.dispose();
  auxMat.dispose();
  return { surface: surfaceRT.texture, aux: auxRT.texture, sea, seed, surfaceRT, auxRT };
}

const PLANET_VERT = /* glsl */ `
varying vec3 vRay;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRay = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = 0.0; // depth is written in the fragment shader
}
`;

const PLANET_FRAG = /* glsl */ `
${NOISE_GLSL}
#define PI 3.14159265
uniform vec3 uCamPos;   // camera relative to Earth centre (m)
uniform float uCgnd;    // |o|^2 - Rg^2 (computed in double precision on CPU)
uniform float uCatm;
uniform float uCcld;
uniform float uRg;
uniform float uRa;
uniform float uRc;
uniform vec3 uSunDir;
uniform float uSunI;
uniform mat3 uEarthInv;
uniform mat3 uCloudInv;
uniform samplerCube uSurface;
uniform samplerCube uAux;
uniform float uSea;
uniform vec3 uCamFwd;
uniform float uPixelAngle;
uniform float uDetail;
uniform float logDepthBufFC;
varying vec3 vRay;

const vec3 betaR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float betaM = 21e-6;
const float HR = 8000.0;
const float HM = 1200.0;
const int ISTEPS = ATMO_STEPS;
const int JSTEPS = 5;

bool sphere(float b, float c, out float t0, out float t1) {
  float disc = b * b - c;
  if (disc < 0.0) { t0 = t1 = -1.0; return false; }
  float s = sqrt(disc);
  t0 = -b - s; t1 = -b + s;
  return true;
}

// optical depth from point p toward the sun to the top of the atmosphere
vec2 sunOpticalDepth(vec3 p, out bool shadow) {
  float bl = dot(p, uSunDir);
  float pp = dot(p, p);
  float cg = pp - uRg * uRg;
  float dg = bl * bl - cg;
  shadow = dg > 0.0 && (-bl - sqrt(dg)) > 0.0;
  float ca = pp - uRa * uRa;
  float tl = -bl + sqrt(max(bl * bl - ca, 0.0));
  float dsl = tl / float(JSTEPS);
  vec2 od = vec2(0.0);
  for (int j = 0; j < JSTEPS; j++) {
    vec3 pl = p + uSunDir * ((float(j) + 0.5) * dsl);
    float hl = max(length(pl) - uRg, 0.0);
    od += vec2(exp(-hl / HR), exp(-hl / HM)) * dsl;
  }
  return od;
}

vec3 scatter(vec3 o, vec3 d, float t0, float t1, out vec3 trans) {
  float ds = (t1 - t0) / float(ISTEPS);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  float mu = dot(d, uSunDir);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.76;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  for (int i = 0; i < ISTEPS; i++) {
    float t = t0 + (float(i) + 0.5) * ds;
    vec3 p = o + d * t;
    float h = max(length(p) - uRg, 0.0);
    float hr = exp(-h / HR) * ds;
    float hm = exp(-h / HM) * ds;
    odR += hr; odM += hm;
    bool sh;
    vec2 odl = sunOpticalDepth(p, sh);
    if (sh) continue;
    vec3 tau = betaR * (odR + odl.x) + betaM * 1.1 * (odM + odl.y);
    vec3 att = exp(-tau);
    sumR += hr * att;
    sumM += hm * att;
  }
  trans = exp(-(betaR * odR + betaM * 1.1 * odM));
  return uSunI * (sumR * betaR * phaseR + sumM * betaM * phaseM);
}

vec3 sunTransmittance(vec3 p) {
  bool sh;
  vec2 od = sunOpticalDepth(p, sh);
  return exp(-(betaR * od.x + betaM * 1.1 * od.y));
}

float writeDepth(float t, vec3 d) {
  float w = t * dot(d, uCamFwd);
  return log2(1.0 + w) * logDepthBufFC * 0.5;
}

void main() {
  vec3 d = normalize(vRay);
  vec3 o = uCamPos;
  float b = dot(o, d);
  float ta0, ta1, tg0, tg1, tc0, tc1;
  bool hitA = sphere(b, uCatm, ta0, ta1);
  if (!hitA || ta1 < 0.0) discard;
  bool hitG = sphere(b, uCgnd, tg0, tg1) && tg0 > 0.0;
  float tStart = max(ta0, 0.0);
  float tEnd = hitG ? tg0 : ta1;

  vec3 color = vec3(0.0);
  float alpha = 0.0;
  float depth = 1.0;
  float sunI = uSunI;

  if (hitG) {
    vec3 P = o + d * tg0;
    vec3 n = normalize(P);
    vec3 nf = uEarthInv * n;
    vec4 surf = textureCube(uSurface, nf);
    vec4 aux = textureCube(uAux, nf);
    float footprint = tg0 * uPixelAngle; // metres per pixel
    float detailFade = uDetail * (1.0 - smoothstep(1500.0, 9000.0, footprint));
    float h = aux.b;
    if (detailFade > 0.0) {
      h += detailFade * (0.035 * snoise(nf * 260.0) + 0.018 * snoise(nf * 610.0) + 0.009 * snoise(nf * 1400.0));
    }
    float NdL = dot(n, uSunDir);
    vec3 Tsun = sunTransmittance(P + n * 10.0);
    float lit = smoothstep(-0.02, 0.06, NdL);
    // cloud shadow
    float cShadow = textureCube(uAux, uCloudInv * normalize(n + uSunDir * 0.0015)).r;
    float shade = 1.0 - 0.65 * cShadow;

    vec3 albedo;
    float water = step(h, uSea);
    if (water > 0.5) {
      float depthW = uSea - h;
      albedo = mix(vec3(0.018, 0.10, 0.12), vec3(0.003, 0.014, 0.045), smoothstep(0.0, 0.03, depthW));
      float lat = abs(nf.y);
      float ice = smoothstep(0.87, 0.93, lat + 0.03 * aux.a + 0.02 * sin(nf.x * 40.0));
      albedo = mix(albedo, vec3(0.7, 0.75, 0.8), ice);
      water = 1.0 - ice;
    } else {
      albedo = surf.rgb * surf.rgb;
      if (detailFade > 0.0) albedo *= 1.0 + detailFade * 0.35 * snoise(nf * 900.0);
      // beaches
      albedo = mix(vec3(0.32, 0.28, 0.2), albedo, smoothstep(0.0, 0.004, h - uSea));
    }
    vec3 ground = albedo * Tsun * sunI * max(NdL, 0.0) / PI * shade;
    // skylight ambient
    ground += albedo * vec3(0.35, 0.55, 1.0) * 0.025 * sunI * smoothstep(-0.2, 0.4, NdL);
    if (water > 0.0) {
      vec3 V = -d;
      vec3 H = normalize(uSunDir + V);
      float nh = max(dot(n, H), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      float spec = pow(nh, 900.0) * 30.0 + pow(nh, 90.0) * 0.6;
      ground += water * Tsun * sunI * spec * (0.25 + fres) * lit * shade * 0.08;
      ground += water * fres * vec3(0.25, 0.45, 0.9) * 0.03 * sunI * smoothstep(-0.1, 0.3, NdL);
    }
    // night lights
    float night = smoothstep(0.08, -0.12, NdL);
    ground += vec3(1.0, 0.68, 0.32) * surf.a * night * 1.6 * (1.0 - 0.7 * cShadow);
    color = ground;
    alpha = 1.0;
    depth = writeDepth(tg0, d);
  }

  // cloud layer
  bool hitC = sphere(b, uCcld, tc0, tc1);
  if (hitC) {
    float tc = tc0 > 0.0 ? tc0 : tc1;
    if (tc > 0.0 && (!hitG || tc < tg0)) {
      vec3 Pc = o + d * tc;
      vec3 nc = normalize(Pc);
      vec3 cf = uCloudInv * nc;
      float cov = textureCube(uAux, cf).r;
      float fp = tc * uPixelAngle;
      float df = uDetail * (1.0 - smoothstep(800.0, 6000.0, fp));
      if (df > 0.0) cov = clamp(cov + df * (0.25 * snoise(cf * 420.0) + 0.12 * snoise(cf * 1100.0)) * cov, 0.0, 1.0);
      float NdLc = dot(nc, uSunDir);
      vec3 Tc = sunTransmittance(Pc);
      float below = tc0 > 0.0 ? 1.0 : 0.45; // seen from underneath: darker
      vec3 cc = vec3(0.92, 0.94, 1.0) * Tc * sunI * (max(NdLc, 0.0) * 0.9 + 0.08) / PI * below;
      cc += vec3(0.3, 0.45, 0.8) * 0.012 * sunI * smoothstep(-0.2, 0.3, NdLc);
      float a = cov * 0.96;
      color = cc * a + color * (1.0 - a);
      alpha = a + alpha * (1.0 - a);
      if (!hitG && a > 0.7) depth = writeDepth(tc, d);
    }
  }

  vec3 T;
  vec3 ins = scatter(o, d, tStart, tEnd, T);
  color = color * T + ins;
  float skyA = 1.0 - dot(T, vec3(0.333));
  alpha = alpha + (1.0 - alpha) * clamp(skyA * 1.4, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha);
  gl_FragDepth = depth;
}
`;

export class Earth {
  constructor(renderer, { quality = 'high', seed = 3.0 } = {}) {
    const size = quality === 'ultra' ? 2048 : quality === 'high' ? 2048 : quality === 'medium' ? 1024 : 512;
    this.maps = bakeEarthMaps(renderer, { size, seed });
    const steps = quality === 'low' ? 8 : quality === 'medium' ? 12 : 16;
    this.uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uCgnd: { value: 0 },
      uCatm: { value: 0 },
      uCcld: { value: 0 },
      uRg: { value: R_EARTH },
      uRa: { value: R_EARTH + ATMO_VISUAL_HEIGHT },
      uRc: { value: R_EARTH + CLOUD_HEIGHT },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunI: { value: 7 },
      uEarthInv: { value: new THREE.Matrix3() },
      uCloudInv: { value: new THREE.Matrix3() },
      uSurface: { value: this.maps.surface },
      uAux: { value: this.maps.aux },
      uSea: { value: this.maps.sea },
      uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
      uPixelAngle: { value: 0.001 },
      uDetail: { value: quality === 'low' ? 0 : 1 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: this.uniforms,
      defines: { ATMO_STEPS: steps },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    // circumscribing shell (ray tracing happens per pixel)
    const shellR = (R_EARTH + ATMO_VISUAL_HEIGHT) * 1.01;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(shellR, 96, 64), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
    this.rotation = 0;
    this._m4 = new THREE.Matrix4();
  }

  /**
   * @param camWorld  camera position in the inertial frame (double precision Vector3)
   * @param origin    render origin (floating origin) in the inertial frame
   */
  update(simTime, camWorld, origin, camera, sunDir, viewportHeight) {
    const u = this.uniforms;
    // Earth centre is at world (0,0,0) => render position = -origin
    this.mesh.position.set(-origin.x, -origin.y, -origin.z);
    u.uCamPos.value.copy(camWorld);
    const o2 = camWorld.x * camWorld.x + camWorld.y * camWorld.y + camWorld.z * camWorld.z;
    u.uCgnd.value = o2 - u.uRg.value * u.uRg.value;
    u.uCatm.value = o2 - u.uRa.value * u.uRa.value;
    u.uCcld.value = o2 - u.uRc.value * u.uRc.value;
    u.uSunDir.value.copy(sunDir);
    this.rotation = (simTime * EARTH_ROT) % (Math.PI * 2);
    this._m4.makeRotationY(-this.rotation);
    u.uEarthInv.value.setFromMatrix4(this._m4);
    // clouds drift slowly relative to the ground
    this._m4.makeRotationY(-this.rotation - simTime * 4e-6 - 0.3);
    u.uCloudInv.value.setFromMatrix4(this._m4);
    camera.getWorldDirection(u.uCamFwd.value);
    u.uPixelAngle.value = ((camera.fov * Math.PI) / 180) / viewportHeight;
  }
}
