import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { propagateKepler, elementsFromState, stateFromElements, hohmannDv, closestApproach } from '../src/sim/orbit.js';
import { Spacecraft } from '../src/sim/spacecraft.js';
import { MU, R_EARTH } from '../src/sim/constants.js';

test('circular orbit elements', () => {
  const a = R_EARTH + 400e3;
  const { r, v } = stateFromElements({ a, e: 0, i: 0.9, raan: 1, argp: 0, nu: 0.3 });
  const el = elementsFromState(r, v);
  assert.ok(Math.abs(el.a - a) < 1e-3);
  assert.ok(el.e < 1e-9);
  assert.ok(Math.abs(el.i - 0.9) < 1e-9);
});

test('equatorial prograde orbit moves east (-Z at +X) and has i=0', () => {
  const { r, v } = stateFromElements({ a: 7e6 });
  assert.ok(Math.abs(r.x - 7e6) < 1e-6);
  assert.ok(v.z < 0);
  assert.ok(elementsFromState(r, v).i < 1e-9);
});

test('kepler propagation returns to start after one period', () => {
  const { r, v } = stateFromElements({ a: 7.2e6, e: 0.1, i: 0.5, raan: 0.2, argp: 1, nu: 2 });
  const T = 2 * Math.PI * Math.sqrt(7.2e6 ** 3 / MU);
  const out = propagateKepler(r, v, T * 0.37);
  const back = propagateKepler(out.r.clone(), out.v.clone(), T * 0.63);
  assert.ok(back.r.distanceTo(r) < 1e-2, `dist ${back.r.distanceTo(r)}`);
  // energy conserved
  const e0 = v.lengthSq() / 2 - MU / r.length();
  const e1 = out.v.lengthSq() / 2 - MU / out.r.length();
  assert.ok(Math.abs(e0 - e1) < 1e-3);
});

test('hyperbolic propagation conserves energy', () => {
  const r = new Vector3(7e6, 0, 0);
  const v = new Vector3(0, 0, -12000);
  const out = propagateKepler(r, v, 3000);
  const e0 = v.lengthSq() / 2 - MU / r.length();
  const e1 = out.v.lengthSq() / 2 - MU / out.r.length();
  assert.ok(Math.abs(e0 - e1) / Math.abs(e0) < 1e-8);
});

test('RK4 spacecraft matches Kepler over one orbit', () => {
  const ship = new Spacecraft();
  const { r, v } = stateFromElements({ a: R_EARTH + 420e3, e: 0.01, i: 0.9, nu: 0.5 });
  ship.r.copy(r);
  ship.v.copy(v);
  const el = elementsFromState(r, v);
  const dt = 1 / 30;
  const n = Math.round(el.period / 2 / dt);
  for (let k = 0; k < n; k++) ship.step(dt, {});
  const ref = propagateKepler(r, v, n * dt);
  assert.ok(ship.r.distanceTo(ref.r) < 1, `drift ${ship.r.distanceTo(ref.r)} m`);
});

test('main engine burn delivers rocket-equation delta-v', () => {
  const ship = new Spacecraft();
  ship.r.set(R_EARTH + 400e3, 0, 0);
  ship.v.set(0, 0, -Math.sqrt(MU / ship.r.length()));
  const dv0 = ship.deltaV;
  ship.throttle = 1;
  for (let k = 0; k < 60 * 30; k++) ship.step(1 / 60, {});
  assert.ok(Math.abs(ship.dvUsed - (dv0 - ship.deltaV)) < 1, `${ship.dvUsed} vs ${dv0 - ship.deltaV}`);
});

test('hohmann LEO raise', () => {
  const dv = hohmannDv(R_EARTH + 300e3, R_EARTH + 420e3);
  assert.ok(dv > 60 && dv < 75, `dv ${dv}`);
});

test('closest approach finds co-orbiting target', () => {
  const A = stateFromElements({ a: 7e6, nu: 0 });
  const B = stateFromElements({ a: 7e6, nu: 0.001 });
  const ca = closestApproach(A.r, A.v, B.r, B.v, 600);
  assert.ok(Math.abs(ca.distance - 7000) < 50, `ca ${ca.distance}`);
});

test('ballistic re-entry heats shield and capsule survives when oriented', () => {
  const ship = new Spacecraft();
  // shallow entry: periapsis ~ 45 km from 120 km
  const ra = R_EARTH + 400e3;
  const rp = R_EARTH + 45e3;
  const a = (ra + rp) / 2;
  const e = (ra - rp) / (ra + rp);
  // start at radius ~ R + 125 km on the inbound leg
  const p = a * (1 - e * e);
  const rStart = R_EARTH + 125e3;
  const nu = -Math.acos((p / rStart - 1) / e);
  const s = stateFromElements({ a, e, i: 0.9, nu });
  ship.r.copy(s.r);
  ship.v.copy(s.v);
  ship.stage = 1;
  ship.setSasMode('retrograde'); ship.autoRoll = true;
  let t = 0;
  const dt = 1 / 30;
  while (!ship.destroyed && !ship.landed && t < 3000) {
    if (ship.chute === 'stowed' && ship.altitude < 10000) ship.stageAction();
    if (ship.chute === 'drogue' && ship.altitude < 5000) ship.stageAction();
    ship.step(dt, {});
    t += dt;
  }
  assert.ok(!ship.destroyed, ship.destroyReason);
  assert.ok(ship.landed);
  assert.ok(ship.maxG > 2 && ship.maxG < 12, `maxG ${ship.maxG}`);
  assert.ok(ship.shield > 0.05 && ship.shield < 0.99, `shield ${ship.shield}`);
  assert.ok(ship.landingSpeed < 12, `landing ${ship.landingSpeed}`);
});
