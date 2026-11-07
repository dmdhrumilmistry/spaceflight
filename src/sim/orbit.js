// Two-body orbital mechanics helpers (double precision, plain {x,y,z} vectors
// via THREE.Vector3 which stores JS numbers = float64).
import { Vector3 } from 'three';
import { MU } from './constants.js';

const TWO_PI = Math.PI * 2;

function stumpC(z) {
  if (z > 1e-8) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-8) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24;
}
function stumpS(z) {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120;
}

/**
 * Universal-variable Kepler propagation (Curtis alg. 3.4).
 * Returns new {r, v} after dt seconds. Works for elliptic & hyperbolic orbits.
 */
export function propagateKepler(r0, v0, dt, mu = MU, outR = new Vector3(), outV = new Vector3()) {
  const ro = r0.length();
  const vo = v0.length();
  const vro = r0.dot(v0) / ro;
  const alpha = 2 / ro - (vo * vo) / mu;
  const sqrtMu = Math.sqrt(mu);

  // Reduce dt modulo the period for bound orbits so Newton converges quickly.
  if (alpha > 1e-12) {
    const period = TWO_PI * Math.sqrt(1 / (alpha * alpha * alpha * mu));
    dt = dt % period;
  }
  if (Math.abs(dt) < 1e-9) {
    outR.copy(r0);
    outV.copy(v0);
    return { r: outR, v: outV };
  }

  let x = sqrtMu * Math.abs(alpha) * dt;
  if (alpha <= 1e-12) x = (Math.sign(dt) * Math.sqrt(mu) * Math.abs(dt)) / ro;
  let z = 0;
  for (let i = 0; i < 80; i++) {
    z = alpha * x * x;
    const C = stumpC(z);
    const S = stumpS(z);
    const F = ((ro * vro) / sqrtMu) * x * x * C + (1 - alpha * ro) * x * x * x * S + ro * x - sqrtMu * dt;
    const dF = ((ro * vro) / sqrtMu) * x * (1 - alpha * x * x * S) + (1 - alpha * ro) * x * x * C + ro;
    const ratio = F / dF;
    x -= ratio;
    if (Math.abs(ratio) < 1e-9) break;
  }
  z = alpha * x * x;
  const C = stumpC(z);
  const S = stumpS(z);
  const f = 1 - ((x * x) / ro) * C;
  const g = dt - (1 / sqrtMu) * x * x * x * S;
  const rx = f * r0.x + g * v0.x;
  const ry = f * r0.y + g * v0.y;
  const rz = f * r0.z + g * v0.z;
  const r = Math.hypot(rx, ry, rz);
  const fdot = (sqrtMu / (r * ro)) * (alpha * x * x * x * S - x);
  const gdot = 1 - ((x * x) / r) * C;
  outV.set(fdot * r0.x + gdot * v0.x, fdot * r0.y + gdot * v0.y, fdot * r0.z + gdot * v0.z);
  outR.set(rx, ry, rz);
  return { r: outR, v: outV };
}

/** Classical orbital elements from a state vector. */
export function elementsFromState(r, v, mu = MU) {
  const rm = r.length();
  const vm2 = v.lengthSq();
  const h = new Vector3().crossVectors(r, v);
  const hm = h.length();
  const evec = r
    .clone()
    .multiplyScalar(vm2 - mu / rm)
    .sub(v.clone().multiplyScalar(r.dot(v)))
    .divideScalar(mu);
  const e = evec.length();
  const energy = vm2 / 2 - mu / rm;
  const a = -mu / (2 * energy);
  const p = (hm * hm) / mu;
  const i = Math.acos(Math.max(-1, Math.min(1, h.y / hm)));
  const rp = p / (1 + e);
  const ra = e < 1 ? p / (1 - e) : Infinity;

  // True anomaly
  let nu;
  if (e > 1e-7) {
    const c = Math.max(-1, Math.min(1, evec.dot(r) / (e * rm)));
    nu = Math.acos(c);
    if (r.dot(v) < 0) nu = TWO_PI - nu;
  } else {
    nu = 0;
  }
  const period = e < 1 ? TWO_PI * Math.sqrt((a * a * a) / mu) : Infinity;

  // Time to periapsis / apoapsis
  let timeToPe = NaN;
  let timeToAp = NaN;
  if (e < 1 && e > 1e-5) {
    const n = Math.sqrt(mu / (a * a * a));
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
    let M = E - e * Math.sin(E);
    M = ((M % TWO_PI) + TWO_PI) % TWO_PI;
    timeToPe = (TWO_PI - M) / n;
    timeToAp = (((Math.PI - M) % TWO_PI) + TWO_PI) % TWO_PI / n;
  } else if (e >= 1) {
    const n = Math.sqrt(mu / (-a * -a * -a));
    const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    const M = e * Math.sinh(F) - F;
    timeToPe = M < 0 ? -M / n : NaN;
  }
  return { a, e, i, p, h, hm, evec, nu, rp, ra, period, energy, timeToPe, timeToAp };
}

/**
 * Build a state vector from elements.
 * raan: rotation of the ascending node about +Y from +X; argp: argument of periapsis;
 * nu: true anomaly. Prograde (eastward) orbits have i < 90 deg.
 */
export function stateFromElements({ a, e = 0, i = 0, raan = 0, argp = 0, nu = 0 }, mu = MU) {
  const N = new Vector3(Math.cos(raan), 0, -Math.sin(raan)); // ascending node direction
  const hHat = new Vector3(0, 1, 0).applyAxisAngle(N, i);
  const Q0 = new Vector3().crossVectors(hHat, N);
  const P = N.clone().multiplyScalar(Math.cos(argp)).add(Q0.clone().multiplyScalar(Math.sin(argp)));
  const Q = new Vector3().crossVectors(hHat, P);
  const p = a * (1 - e * e);
  const rm = p / (1 + e * Math.cos(nu));
  const r = P.clone()
    .multiplyScalar(Math.cos(nu) * rm)
    .add(Q.clone().multiplyScalar(Math.sin(nu) * rm));
  const k = Math.sqrt(mu / p);
  const v = P.clone()
    .multiplyScalar(-Math.sin(nu) * k)
    .add(Q.clone().multiplyScalar((e + Math.cos(nu)) * k));
  return { r, v };
}

/** Sample the osculating orbit as Earth-centred points for drawing. */
export function sampleOrbit(r, v, count = 256, maxRadius = 6e8, mu = MU) {
  const el = elementsFromState(r, v, mu);
  const pts = [];
  const { e, p } = el;
  let P, Q;
  const hHat = el.h.clone().normalize();
  if (e > 1e-7) P = el.evec.clone().normalize();
  else P = r.clone().normalize();
  Q = new Vector3().crossVectors(hHat, P);

  let nuMin = 0;
  let nuMax = TWO_PI;
  if (e >= 1) {
    // limit hyperbola to maxRadius
    const cosLim = (p / maxRadius - 1) / e;
    const lim = Math.acos(Math.max(-1, Math.min(1, cosLim)));
    nuMin = -lim * 0.999;
    nuMax = lim * 0.999;
  }
  for (let k = 0; k <= count; k++) {
    const nu = nuMin + ((nuMax - nuMin) * k) / count;
    const rm = p / (1 + e * Math.cos(nu));
    if (rm > maxRadius || rm < 0) continue;
    pts.push(
      P.x * Math.cos(nu) * rm + Q.x * Math.sin(nu) * rm,
      P.y * Math.cos(nu) * rm + Q.y * Math.sin(nu) * rm,
      P.z * Math.cos(nu) * rm + Q.z * Math.sin(nu) * rm,
    );
  }
  return { points: pts, elements: el, closed: e < 1 };
}

/** Local horizon basis at position r: up (radial), east, north. */
export function localFrame(r) {
  const up = r.clone().normalize();
  const east = new Vector3(0, 1, 0).cross(up);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  const north = new Vector3().crossVectors(up, east);
  return { up, east, north };
}

/** Orbital reference directions (prograde, normal, radial) for the navball. */
export function orbitalDirections(r, v) {
  const prograde = v.clone().normalize();
  const normal = new Vector3().crossVectors(r, v).normalize();
  const radial = new Vector3().crossVectors(prograde, normal).negate().normalize(); // radial out (in-plane, perp to v)
  return { prograde, normal, radial };
}

/**
 * Find the closest approach between two Keplerian trajectories over a window.
 * Returns { distance, time, relSpeed }.
 */
export function closestApproach(rA, vA, rB, vB, window, steps = 240, mu = MU) {
  const tmpRA = new Vector3();
  const tmpVA = new Vector3();
  const tmpRB = new Vector3();
  const tmpVB = new Vector3();
  const distAt = (t) => {
    propagateKepler(rA, vA, t, mu, tmpRA, tmpVA);
    propagateKepler(rB, vB, t, mu, tmpRB, tmpVB);
    return tmpRA.distanceTo(tmpRB);
  };
  let bestT = 0;
  let best = distAt(0);
  const dt = window / steps;
  for (let k = 1; k <= steps; k++) {
    const d = distAt(k * dt);
    if (d < best) {
      best = d;
      bestT = k * dt;
    }
  }
  // golden-section refine
  let lo = Math.max(0, bestT - dt);
  let hi = Math.min(window, bestT + dt);
  const gr = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 30; it++) {
    const c = hi - gr * (hi - lo);
    const d = lo + gr * (hi - lo);
    if (distAt(c) < distAt(d)) hi = d;
    else lo = c;
  }
  const t = (lo + hi) / 2;
  const distance = distAt(t);
  const relSpeed = tmpVA.distanceTo(tmpVB);
  return { distance, time: t, relSpeed };
}

/** Hohmann transfer delta-v between two circular orbit radii. */
export function hohmannDv(r1, r2, mu = MU) {
  const at = (r1 + r2) / 2;
  const dv1 = Math.abs(Math.sqrt(mu * (2 / r1 - 1 / at)) - Math.sqrt(mu / r1));
  const dv2 = Math.abs(Math.sqrt(mu / r2) - Math.sqrt(mu * (2 / r2 - 1 / at)));
  return dv1 + dv2;
}
