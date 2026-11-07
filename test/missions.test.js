// End-to-end mission tests: the real Game loop + mission logic with the
// renderer/HUD stubbed out, flown by simple scripted autopilots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion, Matrix4 } from 'three';
import { Game, WARP_LEVELS } from '../src/game/game.js';
import { elementsFromState } from '../src/sim/orbit.js';
import { R_EARTH } from '../src/sim/constants.js';
import { Progress } from '../src/game/progress.js';

function makeGame() {
  const toasts = [];
  const view = {
    camMode: 'chase',
    orbitCam: {},
    debris: [],
    scene: { remove() {} },
    station: { colliders: [{ min: new Vector3(-2.2, -2.2, -19.7), max: new Vector3(2.2, 2.2, 27) }], portLocal: new Vector3(0, 0, -20.6) },
    shipModel: { detachServiceModule: () => ({}) },
    setStation() {},
    setDebrisVisible() {},
    updateOrbitLine() {},
    spawnDebris() {},
    removeRemote() {},
    render: () => ({ eclipse: 1 }),
    toggleMap() {},
    cycleCamera() {},
  };
  const hud = {
    showBriefing() {},
    hideOverlays() {},
    popup() {},
    toast: (m) => toasts.push(m),
    showResult(m, r) {
      if (process.env.SHOW_SCORES) console.log(`[score] ${m.id}: ${r.total} (${r.stars}★) ${r.reason} :: ${JSON.stringify(r.bonuses)}`);
    },
    showPause() {},
    achievement() {},
    update() {},
  };
  const input = {
    v: {},
    handlers: [],
    onKey(fn) {
      this.handlers.push(fn);
    },
    axis(neg, pos) {
      return (this.v[pos] || 0) - (this.v[neg] || 0);
    },
    down() {
      return false;
    },
  };
  const progress = new Progress();
  const game = new Game({ view, hud, input, net: null, progress });
  game.toasts = toasts;
  return game;
}

function setAxis(input, neg, pos, val) {
  input.v[pos] = Math.max(0, val);
  input.v[neg] = Math.max(0, -val);
}

function run(game, maxFrames, each) {
  for (let i = 0; i < maxFrames && game.state !== 'ended'; i++) {
    each?.(i);
    game.update(1 / 60);
  }
  if (game.result) game.hud.showResult(game.mission, game.result);
}

test('attitude mission: manual tumble recovery then SAS pointing', () => {
  const game = makeGame();
  game.start('attitude');
  game.launch();
  const modes = { 1: 'prograde', 2: 'radialOut', 3: 'normal', 4: 'retrograde' };
  run(game, 60 * 400, () => {
    const ship = game.ship;
    const ph = game.mission.phase;
    if (ph === 0) {
      setAxis(game.input, 'KeyW', 'KeyS', -ship.w.x * 40);
      setAxis(game.input, 'KeyD', 'KeyA', -ship.w.y * 40);
      setAxis(game.input, 'KeyE', 'KeyQ', -ship.w.z * 40);
    } else {
      game.input.v = {};
      if (ship.sasMode !== modes[ph]) ship.setSasMode(modes[ph]);
    }
  });
  assert.equal(game.state, 'ended');
  assert.ok(game.result.success, game.result.reason);
  assert.ok(game.result.total > 1000, `score ${game.result.total}`);
});

test('circularization mission', () => {
  const game = makeGame();
  game.start('circularize');
  game.launch();
  game.ship.setSasMode('prograde');
  run(game, 60 * 900, () => {
    const ship = game.ship;
    const el = elementsFromState(ship.r, ship.v);
    const aligned = ship.forward(new Vector3()).angleTo(ship.v) < 0.02;
    const pe = el.rp - R_EARTH;
    // burn centred on apoapsis
    if (aligned && pe < 400e3 && (el.timeToAp < 40 || el.timeToAp > el.period - 60)) ship.throttle = 1;
    if (pe >= 400e3) ship.throttle = 0;
  });
  assert.ok(game.result?.success, game.result?.reason);
  assert.ok(game.result.total > 900, `score ${game.result.total}`);
});

test('hohmann mission with time warp', () => {
  const game = makeGame();
  game.start('hohmann');
  game.launch();
  let phase = 0;
  run(game, 60 * 1500, () => {
    const ship = game.ship;
    const el = elementsFromState(ship.r, ship.v);
    if (phase === 0) {
      ship.throttle = el.ra - R_EARTH < 420e3 ? 1 : 0;
      if (ship.throttle === 0) phase = 1;
    } else if (phase === 1) {
      if (el.timeToAp > 120 && el.timeToAp < el.period - 60) game.warpIndex = WARP_LEVELS.indexOf(100);
      else {
        game.warpIndex = 0;
        if (el.timeToAp < 20 || el.timeToAp > el.period - 20) phase = 2;
      }
    } else {
      ship.throttle = el.rp - R_EARTH < 415e3 ? 1 : 0;
    }
  });
  assert.ok(game.result?.success, game.result?.reason);
  assert.ok(game.result.total > 1100, `score ${game.result.total}`);
});

test('docking mission: translation autopilot achieves soft capture', () => {
  const game = makeGame();
  game.start('docking');
  game.launch();
  const st = () => game.station;
  run(game, 60 * 1200, () => {
    const ship = game.ship;
    const s = st();
    // keep perfectly aligned (rotation is tested elsewhere)
    const axis = s.portAxis();
    const up = new Vector3(0, 1, 0).applyQuaternion(s.q);
    const z = axis.clone();
    const x = new Vector3().crossVectors(up, z);
    ship.q.setFromRotationMatrix(new Matrix4().makeBasis(x, up, z));
    ship.w.set(0, 0, 0);
    const d = game.computeDocking();
    // desired: lateral -> 0, approach speed proportional to range
    const vApp = Math.min(0.6, Math.max(0.12, d.axial * 0.04));
    const qi = ship.q.clone().invert();
    const sx = new Vector3(1, 0, 0).applyQuaternion(s.q);
    const sy = new Vector3(0, 1, 0).applyQuaternion(s.q);
    const relV = d.relV;
    const desired = axis.clone().multiplyScalar(-vApp).addScaledVector(sx, -d.latX * 0.08).addScaledVector(sy, -d.latY * 0.08);
    const err = desired.sub(relV).applyQuaternion(qi).multiplyScalar(8);
    setAxis(game.input, 'KeyJ', 'KeyL', Math.max(-1, Math.min(1, err.x)));
    setAxis(game.input, 'KeyK', 'KeyI', Math.max(-1, Math.min(1, err.y)));
    setAxis(game.input, 'KeyH', 'KeyN', Math.max(-1, Math.min(1, err.z)));
  });
  assert.ok(game.result?.success, game.result?.reason + ' ' + JSON.stringify(game.docking));
  assert.ok(game.docked);
  assert.ok(game.result.total > 1200, `score ${game.result.total}`);
});

test('re-entry mission: deorbit, separation, lifting entry, chutes, splashdown', () => {
  const game = makeGame();
  game.start('reentry');
  game.launch();
  game.ship.autoRoll = true;
  let phase = 0;
  run(game, 60 * 3000, () => {
    const ship = game.ship;
    const el = elementsFromState(ship.r, ship.v);
    const alt = ship.altitude;
    if (phase === 0) {
      const aligned = ship.forward(new Vector3()).angleTo(ship.v.clone().negate()) < 0.03;
      ship.throttle = aligned && el.rp - R_EARTH > 50e3 ? 1 : 0;
      if (el.rp - R_EARTH <= 50e3) {
        ship.throttle = 0;
        phase = 1;
      }
    } else if (phase === 1) {
      game.doStage(); // jettison SM
      phase = 2;
    } else if (phase === 2) {
      game.warpIndex = alt > 160e3 ? WARP_LEVELS.indexOf(1000) : WARP_LEVELS.indexOf(10);
      if (ship.chute === 'stowed' && alt < 10000 && ship.airVel.length() < 290) game.doStage();
      if (ship.chute === 'drogue' && alt < 5000) game.doStage();
    }
  });
  assert.ok(game.result?.success, game.result?.reason);
  assert.ok(game.ship.maxG < 6, `max g ${game.ship.maxG}`);
  assert.ok(game.result.total > 1400, `score ${game.result.total}`);
});

test('rendezvous mission: transfer at window, then close and match velocity', () => {
  const game = makeGame();
  game.start('rendezvous');
  game.launch();
  let phase = 0;
  const pointAlong = (ship, dir) => {
    const f = ship.forward(new Vector3());
    ship.q.premultiply(new Quaternion().setFromUnitVectors(f, dir.clone().normalize()));
    ship.w.set(0, 0, 0);
  };
  run(game, 60 * 6000, () => {
    const ship = game.ship;
    const st = game.station;
    const el = elementsFromState(ship.r, ship.v);
    const dist = ship.r.distanceTo(st.r);
    if (phase === 0) {
      const win = (game.mission.phaseAngle(game) - game.mission.thetaStar) / game.mission.dn;
      game.warpIndex = win > 30 ? WARP_LEVELS.indexOf(10) : 0;
      if (win <= 0) {
        pointAlong(ship, ship.v);
        ship.throttle = el.ra - R_EARTH < 420e3 ? 1 : 0;
        if (ship.throttle === 0) phase = 1;
      }
    } else if (phase === 1) {
      const ca = game.closest;
      game.warpIndex = dist > 25000 ? WARP_LEVELS.indexOf(100) : 0;
      if (dist < 25000 || (ca && ca.time < 120)) phase = 2;
    } else {
      game.warpIndex = 0;
      const relV = ship.v.clone().sub(st.v);
      const toSt = st.r.clone().sub(ship.r);
      const vDes = toSt.clone().normalize().multiplyScalar(Math.min(8, Math.max(0, (dist - 150) / 120)));
      const e = vDes.sub(relV);
      pointAlong(ship, e);
      ship.throttle = e.length() > 0.3 ? Math.min(1, e.length() / 4) : 0;
    }
  });
  assert.ok(game.result?.success, `${game.result?.reason} dist=${game.ship.r.distanceTo(game.station.r).toFixed(0)}`);
  assert.ok(game.result.total > 1300, `score ${game.result.total}`);
});

test('debris avoidance mission: burn to raise predicted miss, survive the pass', () => {
  const game = makeGame();
  game.start('debris');
  game.launch();
  let burned = false;
  run(game, 60 * 900, () => {
    const ship = game.ship;
    const m = game.mission;
    if (game.missionTime < 4) return;
    if (!burned) {
      // retrograde burn early: cheapest way to shift the encounter geometry
      const f = ship.forward(new Vector3());
      ship.q.premultiply(new Quaternion().setFromUnitVectors(f, ship.v.clone().normalize().negate()));
      ship.w.set(0, 0, 0);
      ship.throttle = m.predicted < 2600 ? 0.3 : 0;
      if (ship.throttle === 0 && game.missionTime > 6) burned = true;
    } else {
      game.warpIndex = m.tcaAbs - game.simTime > 60 ? WARP_LEVELS.indexOf(10) : 0;
    }
  });
  assert.ok(game.result?.success, game.result?.reason);
  assert.ok(game.mission.missDistance > 2000, `miss ${game.mission.missDistance}`);
});

test('debris collision is detected when no burn is made', () => {
  const game = makeGame();
  game.start('debris', { modifiers: { miss: 3, tca: 120 } });
  game.launch();
  run(game, 60 * 400, () => {
    game.warpIndex = game.mission.tcaAbs - game.simTime > 20 ? WARP_LEVELS.indexOf(5) : 0;
  });
  assert.equal(game.result?.success, false);
  assert.ok(game.ship.destroyed, game.result?.reason);
});

test('agent telemetry exposes orbit, pointing and docking data', async () => {
  const { telemetry } = await import('../src/agent/api.js');
  const game = makeGame();
  game.start('docking');
  game.launch();
  run(game, 30);
  const t = telemetry(game);
  assert.equal(t.mission.id, 'docking');
  assert.ok(t.ship.altitudeM > 400000);
  assert.ok(t.docking && t.docking.rangeM > 100 && t.docking.captureLimits.lateralM === 0.3);
  assert.ok(typeof t.pointingErrorDeg.target === 'number');
  assert.equal(t.target.name, 'ISS');
  JSON.stringify(t);
});
