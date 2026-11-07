// Astronaut training curriculum. Each mission sets up initial conditions,
// tracks objectives, awards points and computes completion bonuses.
import { Vector3, Matrix4 } from 'three';
import { stateFromElements, elementsFromState, hohmannDv, orbitalDirections, propagateKepler, closestApproach } from '../sim/orbit.js';
import { R_EARTH, MU, SUN_DIR } from '../sim/constants.js';

const KM = 1000;
const DEG = Math.PI / 180;
const INC = 51.6 * DEG;
const RAAN = 0.35;
const SUN = new Vector3(...SUN_DIR);

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** True anomaly (argp = 0) at which the craft sits under the sun, plus offset. */
function sunlitNu(i, raan, offset = 0) {
  const N = new Vector3(Math.cos(raan), 0, -Math.sin(raan));
  const hHat = new Vector3(0, 1, 0).applyAxisAngle(N, i);
  const Q = new Vector3().crossVectors(hHat, N);
  return Math.atan2(SUN.dot(Q), SUN.dot(N)) + offset;
}

function circular(alt, nu, i = INC, raan = RAAN) {
  return stateFromElements({ a: R_EARTH + alt, e: 0, i, raan, argp: 0, nu });
}

function pointShip(ship, dir, up) {
  // forward (-Z) -> dir, body +Y as close as possible to `up`
  const z = dir.clone().normalize().negate();
  const y = up.clone().addScaledVector(z, -up.dot(z)).normalize();
  const x = new Vector3().crossVectors(y, z);
  ship.q.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b) / (a.length() * b.length()))));
}

const fmtKm = (m) => `${(m / 1000).toFixed(1)} km`;

export const MISSIONS = [
  // ------------------------------------------------------------------
  {
    id: 'attitude',
    title: 'Attitude Control',
    tag: 'Module 1 · Basics',
    difficulty: 1,
    stars: [900, 1400, 1800],
    summary: 'Recover from a tumble by hand, then point the spacecraft at orbital reference vectors.',
    briefing: [
      'Your capsule is tumbling after a simulated thruster malfunction. SAS is offline.',
      'Use W/S (pitch), A/D (yaw) and Q/E (roll) to null all rotation rates below 0.2°/s.',
      'SAS will then come back online: use the navball markers to point PROGRADE, RADIAL OUT, NORMAL and RETROGRADE.',
      'Points: speed, RCS propellant economy, pointing precision.',
    ],
    setup(game) {
      const nu = sunlitNu(INC, RAAN, -0.8);
      const s = circular(400 * KM, nu);
      const ship = game.ship;
      ship.r.copy(s.r);
      ship.v.copy(s.v);
      pointShip(ship, s.v, s.r);
      ship.w.set(0.07, -0.05, 0.06).multiplyScalar(game.modifiers?.tumble ?? 1);
      ship.sasEnabled = false;
      ship.sasLocked = true;
      this.phase = 0;
      this.hold = 0;
      this.errSum = 0;
      this.targets = ['prograde', 'radialOut', 'normal', 'retrograde'];
      game.objectives = [
        { text: 'Null rotation manually (all rates < 0.2°/s)', state: 'active' },
        { text: 'Point PROGRADE ±2° — hold 5 s', state: 'pending' },
        { text: 'Point RADIAL OUT ±2° — hold 5 s', state: 'pending' },
        { text: 'Point NORMAL ±2° — hold 5 s', state: 'pending' },
        { text: 'Point RETROGRADE ±2° — hold 5 s', state: 'pending' },
      ];
    },
    update(game, dt) {
      const ship = game.ship;
      const rates = ship.w;
      if (this.phase === 0) {
        const lim = 0.2 * DEG;
        if (Math.abs(rates.x) < lim && Math.abs(rates.y) < lim && Math.abs(rates.z) < lim) {
          const bonus = Math.round(200 * clamp01(1 - game.missionTime / 120));
          game.award(300 + bonus, 'Tumble recovered');
          game.objectives[0].state = 'done';
          game.objectives[1].state = 'active';
          ship.sasLocked = false;
          ship.sasEnabled = true;
          ship.setSasMode('stability');
          game.toast('SAS online — try the SAS mode buttons (keys 1-9)', 'info');
          this.phase = 1;
        }
        return;
      }
      const dirs = orbitalDirections(ship.r, ship.v);
      const tgtName = this.targets[this.phase - 1];
      const map = {
        prograde: dirs.prograde,
        retrograde: dirs.prograde.clone().negate(),
        radialOut: dirs.radial,
        normal: dirs.normal,
      };
      const err = angleBetween(ship.forward(new Vector3()), map[tgtName]);
      const steady = rates.length() < 0.5 * DEG;
      if (err < 2 * DEG && steady) {
        this.hold += dt;
        this.errSum += err * dt;
      } else {
        this.hold = 0;
        this.errSum = 0;
      }
      game.hint = `Pointing error ${(err / DEG).toFixed(1)}° · hold ${this.hold.toFixed(1)}/5 s`;
      if (this.hold >= 5) {
        const avg = this.errSum / this.hold / DEG;
        const precision = Math.round(100 * clamp01(1 - avg / 2));
        game.award(150 + precision, `${tgtName.replace('radialOut', 'Radial out')} locked`);
        game.objectives[this.phase].state = 'done';
        this.phase++;
        this.hold = 0;
        this.errSum = 0;
        if (this.phase > this.targets.length) {
          game.complete(true, 'All attitude drills complete');
        } else game.objectives[this.phase].state = 'active';
      }
      if (ship.rcsFuel <= 0) game.complete(false, 'RCS propellant exhausted');
    },
    finalize(game) {
      const rcs = game.ship.rcsUsed;
      return [
        { label: `RCS economy (${rcs.toFixed(1)} kg used)`, points: Math.round(400 * clamp01(1 - rcs / 45)) },
        { label: `Time (${game.missionTime.toFixed(0)} s)`, points: Math.round(300 * clamp01(1 - game.missionTime / 420)) },
      ];
    },
  },
  // ------------------------------------------------------------------
  {
    id: 'circularize',
    title: 'Orbit Circularization',
    tag: 'Module 2 · Orbital mechanics',
    difficulty: 2,
    stars: [900, 1400, 1750],
    summary: 'You are approaching apoapsis of a 230 × 410 km orbit. Circularize near 410 km.',
    briefing: [
      'After ascent your capsule is in an elliptical 230 × 410 km orbit, about a minute before apoapsis.',
      'Point PROGRADE (key 2 for SAS prograde) and burn the main engine (Z = full throttle, X = cut, R/F = adjust).',
      'Burn centred on apoapsis until periapsis ≥ 395 km while keeping apoapsis ≤ 425 km.',
      'Points: delta-v efficiency vs. the ideal burn and final eccentricity.',
    ],
    setup(game) {
      const rp = R_EARTH + 230 * KM;
      const ra = R_EARTH + 410 * KM;
      const a = (rp + ra) / 2;
      const e = (ra - rp) / (ra + rp);
      // argp chosen so apoapsis is in sunlight; start ~70 s before apoapsis
      const argp = sunlitNu(INC, RAAN, 0) - Math.PI;
      const p = a * (1 - e * e);
      const nu = Math.PI - (75 * Math.sqrt(MU * p)) / (ra * ra); // ~75 s before apoapsis
      const s = stateFromElements({ a, e, i: INC, raan: RAAN, argp, nu });
      const ship = game.ship;
      ship.r.copy(s.r);
      ship.v.copy(s.v);
      const nrm = new Vector3().crossVectors(s.r, s.v).normalize();
      pointShip(ship, s.v.clone().normalize().applyAxisAngle(nrm, 50 * DEG), s.r);
      ship.setSasMode('stability');
      const vAp = Math.sqrt(MU * (2 / ra - 1 / a));
      this.idealDv = Math.sqrt(MU / ra) - vAp;
      this.done = false;
      game.objectives = [
        { text: 'Point PROGRADE', state: 'active' },
        { text: 'Burn near apoapsis: periapsis ≥ 395 km', state: 'pending' },
        { text: 'Keep apoapsis ≤ 425 km, engine off', state: 'pending' },
      ];
    },
    update(game) {
      const ship = game.ship;
      const el = elementsFromState(ship.r, ship.v);
      const pe = el.rp - R_EARTH;
      const ap = el.ra - R_EARTH;
      const o = game.objectives;
      if (o[0].state !== 'done') {
        const err = angleBetween(ship.forward(new Vector3()), ship.v);
        if (err < 3 * DEG) {
          o[0].state = 'done';
          o[1].state = 'active';
          game.award(100, 'Aligned prograde');
        }
      }
      if (o[1].state !== 'done' && pe >= 395 * KM) {
        o[1].state = 'done';
        o[2].state = 'active';
      }
      game.hint = `Ideal Δv ${this.idealDv.toFixed(1)} m/s · used ${ship.dvUsed.toFixed(1)} m/s`;
      if (pe >= 395 * KM && ap <= 425 * KM && ship.throttle === 0) {
        o[2].state = 'done';
        game.award(800, 'Circular orbit achieved');
        game.complete(true, `Orbit ${fmtKm(pe)} × ${fmtKm(ap)}`);
      }
      if (ap > 520 * KM) game.complete(false, 'Apoapsis too high — overburn');
      if (!ship.canThrust && ship.fuel <= 0) game.complete(false, 'Out of propellant');
    },
    finalize(game) {
      const ship = game.ship;
      const el = elementsFromState(ship.r, ship.v);
      const eff = clamp01(this.idealDv / Math.max(this.idealDv, ship.dvUsed));
      return [
        { label: `Δv efficiency (${(eff * 100).toFixed(1)}%)`, points: Math.round(700 * eff ** 3) },
        { label: `Eccentricity (${el.e.toFixed(4)})`, points: Math.round(300 * clamp01(1 - el.e / 0.0025)) },
      ];
    },
  },
  // ------------------------------------------------------------------
  {
    id: 'hohmann',
    title: 'Hohmann Transfer',
    tag: 'Module 3 · Orbital mechanics',
    difficulty: 2,
    stars: [1100, 1600, 1950],
    summary: 'Raise a 300 km circular orbit to 420 km with a two-burn Hohmann transfer.',
    briefing: [
      'Raise your orbit from 300 km to the station altitude of 420 km.',
      'Burn 1: PROGRADE until apoapsis reads 420 km. Cut the engine.',
      'Coast half an orbit — use time warp ( . and , keys ). Warp stops automatically near apoapsis.',
      'Burn 2: at apoapsis burn PROGRADE until periapsis reaches 410–430 km.',
      'Points: delta-v efficiency vs. ideal Hohmann and final orbit accuracy.',
    ],
    setup(game) {
      const nu = sunlitNu(INC, RAAN, -0.6);
      const s = circular(300 * KM, nu);
      const ship = game.ship;
      ship.r.copy(s.r);
      ship.v.copy(s.v);
      pointShip(ship, s.v, s.r);
      ship.setSasMode('prograde');
      this.idealDv = hohmannDv(R_EARTH + 300 * KM, R_EARTH + 420 * KM);
      this.warpStopped = false;
      game.objectives = [
        { text: 'Burn 1: raise apoapsis to 420 km', state: 'active' },
        { text: 'Coast to apoapsis (time warp)', state: 'pending' },
        { text: 'Burn 2: circularize — Pe & Ap within 410–430 km', state: 'pending' },
      ];
    },
    update(game) {
      const ship = game.ship;
      const el = elementsFromState(ship.r, ship.v);
      const pe = el.rp - R_EARTH;
      const ap = el.ra - R_EARTH;
      const o = game.objectives;
      if (o[0].state !== 'done' && ap >= 410 * KM && ship.throttle === 0) {
        o[0].state = 'done';
        o[1].state = 'active';
        const acc = Math.abs(ap - 420 * KM);
        game.award(150 + Math.round(150 * clamp01(1 - acc / 10000)), 'Transfer orbit');
      }
      if (o[1].state === 'active') {
        if (el.timeToAp < 90 && !this.warpStopped) {
          this.warpStopped = true;
          game.stopWarp('Approaching apoapsis');
        }
        if (el.timeToAp < 60 || el.timeToAp > el.period - 30) {
          o[1].state = 'done';
          o[2].state = 'active';
        }
      }
      game.hint = `Ideal Δv ${this.idealDv.toFixed(1)} m/s · used ${ship.dvUsed.toFixed(1)} m/s`;
      if (pe >= 410 * KM && ap <= 430 * KM && ship.throttle === 0) {
        o.forEach((x) => (x.state = 'done'));
        game.award(800, 'Station orbit reached');
        game.complete(true, `Orbit ${fmtKm(pe)} × ${fmtKm(ap)}`);
      }
      if (ap > 700 * KM) game.complete(false, 'Apoapsis far too high');
      if (pe < 120 * KM) game.complete(false, 'Orbit decayed into the atmosphere');
    },
    finalize(game) {
      const ship = game.ship;
      const el = elementsFromState(ship.r, ship.v);
      const eff = clamp01(this.idealDv / Math.max(this.idealDv, ship.dvUsed));
      const aErr = Math.abs(el.a - (R_EARTH + 420 * KM));
      return [
        { label: `Δv efficiency (${(eff * 100).toFixed(1)}%)`, points: Math.round(800 * eff ** 4) },
        { label: `Orbit accuracy (±${(aErr / 1000).toFixed(1)} km)`, points: Math.round(300 * clamp01(1 - aErr / 10000)) },
      ];
    },
  },
  // ------------------------------------------------------------------
  {
    id: 'rendezvous',
    title: 'Orbital Rendezvous',
    tag: 'Module 4 · Proximity ops',
    difficulty: 4,
    stars: [1300, 1900, 2300],
    summary: 'Catch the station from a lower orbit and null your relative velocity within 300 m.',
    briefing: [
      'The station orbits at 420 km. You are 20 km below and behind it.',
      'Wait for the TRANSFER WINDOW timer, then burn PROGRADE to raise apoapsis to ~420 km.',
      'Watch the CLOSEST APPROACH readout — fine-tune with small burns or RCS (H/N fore-aft, I/K/J/L).',
      'Near the station, point RETROGRADE-to-target (key 9) and burn to kill relative velocity.',
      'Success: within 300 m with relative speed < 1 m/s. Points: fuel, time, precision.',
    ],
    hasStation: true,
    setup(game) {
      const a1 = R_EARTH + 400 * KM;
      const a2 = R_EARTH + 420 * KM;
      const at = (a1 + a2) / 2;
      const n1 = Math.sqrt(MU / a1 ** 3);
      const n2 = Math.sqrt(MU / a2 ** 3);
      const thetaStar = Math.PI * (1 - Math.pow(at / a2, 1.5));
      this.dn = n1 - n2;
      this.thetaStar = thetaStar;
      const wait = game.modifiers?.wait ?? 200;
      const theta0 = thetaStar + this.dn * wait;
      const nuShip = sunlitNu(INC, RAAN, -1.2);
      const s = circular(400 * KM, nuShip);
      const ship = game.ship;
      ship.r.copy(s.r);
      ship.v.copy(s.v);
      pointShip(ship, s.v, s.r);
      ship.setSasMode('prograde');
      game.createStation({ a: a2, i: INC, raan: RAAN, nu0: nuShip + theta0, t0: game.simTime });
      this.idealDv = hohmannDv(a1, a2) + 2;
      this.minDist = Infinity;
      game.objectives = [
        { text: 'Transfer burn at the window (raise Ap ≈ 420 km)', state: 'active' },
        { text: 'Close to within 2 km of the station', state: 'pending' },
        { text: 'Hold within 300 m at < 1 m/s relative', state: 'pending' },
      ];
    },
    phaseAngle(game) {
      const st = game.station;
      const ship = game.ship;
      const h = new Vector3().crossVectors(ship.r, ship.v).normalize();
      const a = ship.r.clone().normalize();
      const b = st.r.clone().normalize();
      let ang = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
      if (new Vector3().crossVectors(a, b).dot(h) < 0) ang = -ang;
      return ang;
    },
    update(game) {
      const ship = game.ship;
      const st = game.station;
      const o = game.objectives;
      const dist = ship.r.distanceTo(st.r);
      const rel = ship.v.distanceTo(st.v);
      this.minDist = Math.min(this.minDist, dist);
      if (o[0].state === 'active') {
        const window = (this.phaseAngle(game) - this.thetaStar) / this.dn;
        game.hint = window > 0 ? `Transfer window in ${window.toFixed(0)} s` : `Transfer window passed ${(-window).toFixed(0)} s ago — burn now!`;
        const el = elementsFromState(ship.r, ship.v);
        if (el.ra - R_EARTH > 412 * KM && ship.throttle === 0) {
          o[0].state = 'done';
          o[1].state = 'active';
          game.award(200 + Math.round(150 * clamp01(1 - Math.abs(window) / 120)), 'Transfer burn');
        }
      } else {
        game.hint = `Range ${dist < 5000 ? dist.toFixed(0) + ' m' : fmtKm(dist)} · rel. speed ${rel.toFixed(2)} m/s`;
      }
      if (o[1].state === 'active' && dist < 2000) {
        o[1].state = 'done';
        o[2].state = 'active';
        game.award(300, 'Proximity reached');
      }
      if (o[2].state === 'active' && dist < 300 && rel < 1) {
        o[2].state = 'done';
        game.award(700, 'Rendezvous complete');
        game.complete(true, `Station-keeping at ${dist.toFixed(0)} m`);
      }
      if (dist < 40) game.complete(false, 'Collision course — too close to the station');
      if (ship.fuel <= 0 && ship.rcsFuel <= 0) game.complete(false, 'Out of propellant');
    },
    finalize(game) {
      const used = game.ship.dvUsed + game.ship.rcsDvUsed;
      const eff = clamp01(this.idealDv / Math.max(this.idealDv, used));
      return [
        { label: `Fuel efficiency (${used.toFixed(1)} m/s used)`, points: Math.round(800 * eff ** 1.5) },
        { label: `Time (${(game.missionTime / 60).toFixed(1)} min)`, points: Math.round(300 * clamp01(1 - game.missionTime / 7200)) },
      ];
    },
  },
  // ------------------------------------------------------------------
  {
    id: 'docking',
    title: 'Manual Docking',
    tag: 'Module 5 · Proximity ops',
    difficulty: 3,
    stars: [1200, 1700, 2050],
    summary: 'Fly the final 120 m to the station port with RCS and achieve soft capture.',
    briefing: [
      'You are holding 120 m from the station’s forward port. Switch to the docking camera with V.',
      'Translate with RCS: H/N forward/back, I/K up/down, J/L left/right. Rotate with WASDQE. ` toggles precision mode.',
      'Keep the closing rate below 1 m/s far out and 0.1–0.3 m/s at contact.',
      'Capture limits: lateral < 0.3 m, angle < 5°, roll < 8°, speed < 0.35 m/s.',
      'Points: contact precision, RCS economy and time.',
    ],
    hasStation: true,
    setup(game, slot = 0) {
      const mods = game.modifiers || {};
      const nu = sunlitNu(INC, RAAN, mods.night ? Math.PI : -0.95);
      const a = R_EARTH + 420 * KM;
      game.createStation({ a, i: INC, raan: RAAN, nu0: nu, t0: game.simTime });
      const st = game.station;
      const ship = game.ship;
      if (mods.rcsScale) ship.rcsFuel *= mods.rcsScale;
      const port = st.portWorld();
      const axis = st.portAxis();
      const side = new Vector3(1, 0, 0).applyQuaternion(st.q);
      const up = new Vector3(0, 1, 0).applyQuaternion(st.q);
      const dist = (mods.dist ?? 120) + slot * 35;
      const nose = port.clone().addScaledVector(axis, dist).addScaledVector(side, (mods.lateral ?? 3.5) + slot * 6).addScaledVector(up, -2);
      const fwd = axis.clone().negate().applyAxisAngle(up, 3 * DEG).applyAxisAngle(side, -2 * DEG);
      pointShip(ship, fwd, up.clone().applyAxisAngle(fwd, 5 * DEG));
      ship.r.copy(nose).addScaledVector(fwd, -ship.spec.noseOffset);
      // co-moving with the station (velocity at this point of the LVLH frame)
      const omega = new Vector3().crossVectors(st.r, st.v).divideScalar(st.r.lengthSq());
      ship.v.copy(st.v).add(new Vector3().crossVectors(omega, ship.r.clone().sub(st.r)));
      ship.setSasMode('stability');
      ship.stage = 0;
      game.view.camMode = 'cockpit';
      this.contacts = 0;
      game.objectives = [
        { text: 'Approach to 30 m (closing < 1 m/s)', state: 'active' },
        { text: 'Align on the port axis inside 10 m', state: 'pending' },
        { text: 'Soft capture', state: 'pending' },
      ];
    },
    update(game) {
      const d = game.docking;
      if (!d) return;
      const o = game.objectives;
      if (o[0].state === 'active' && d.range < 30) {
        o[0].state = 'done';
        o[1].state = 'active';
        game.award(d.closing < 1 ? 150 : 50, 'Approach corridor');
      }
      if (o[1].state === 'active' && d.range < 10 && d.lateral < 0.5 && d.angle < 2) {
        o[1].state = 'done';
        o[2].state = 'active';
        game.award(150, 'Aligned');
      }
      game.hint = `Range ${d.range.toFixed(1)} m · closing ${d.closing.toFixed(2)} m/s · lateral ${d.lateral.toFixed(2)} m · angle ${d.angle.toFixed(1)}°`;
      if (d.range > 700) game.complete(false, 'Drifted out of the approach ellipsoid');
    },
    onDock(game, c) {
      game.objectives.forEach((x) => (x.state = 'done'));
      this.contact = c;
      game.award(800, 'Soft capture!');
      game.complete(true, `Docked at ${c.closing.toFixed(2)} m/s`);
    },
    finalize(game) {
      const c = this.contact;
      if (!c) return [];
      const sp = c.closing;
      const speedScore = sp >= 0.05 && sp <= 0.2 ? 200 : Math.round(200 * clamp01(1 - Math.abs(sp - 0.125) / 0.25));
      return [
        { label: `Lateral error ${(c.lateral * 100).toFixed(0)} cm`, points: Math.round(300 * clamp01(1 - c.lateral / 0.3)) },
        { label: `Angular error ${c.angle.toFixed(2)}°`, points: Math.round(200 * clamp01(1 - c.angle / 5)) },
        { label: `Contact speed ${sp.toFixed(2)} m/s`, points: speedScore },
        { label: `RCS economy (${game.ship.rcsUsed.toFixed(1)} kg)`, points: Math.round(200 * clamp01(1 - game.ship.rcsUsed / 60)) },
        { label: `Time (${game.missionTime.toFixed(0)} s)`, points: Math.round(150 * clamp01(1 - game.missionTime / 900)) },
      ];
    },
  },
  // ------------------------------------------------------------------
  {
    id: 'debris',
    title: 'Debris Avoidance',
    tag: 'Module 6 · Space safety',
    difficulty: 3,
    stars: [1100, 1550, 1900],
    summary: 'A tracked fragment will pass dangerously close. Plan and fly a collision-avoidance manoeuvre.',
    briefing: [
      'CONJUNCTION ALERT. A fragment of a spent rocket stage on a 98° sun-synchronous orbit will cross your path at ~10 km/s.',
      'The TARGET panel shows TCA (time of closest approach) and the predicted MISS distance. Anything under 2 km is too close.',
      'Burn to push the predicted miss above 2 km. Early prograde/retrograde burns (keys 2/3) are cheapest; close to TCA, radial burns (6/7) act fastest.',
      'Then hold attitude and ride out the pass. Points: final margin, Δv economy, and how early you acted.',
    ],
    setup(game) {
      const mods = game.modifiers || {};
      this.tca = mods.tca ?? 420;
      const miss0 = mods.miss ?? 85;
      const nu = sunlitNu(INC, RAAN, -0.5);
      const s = circular(415 * KM, nu);
      const ship = game.ship;
      ship.r.copy(s.r);
      ship.v.copy(s.v);
      pointShip(ship, s.v, s.r);
      ship.setSasMode('stability');
      // debris position at TCA: just above our future position, on a 98° orbit
      const at = propagateKepler(s.r, s.v, this.tca);
      const rHat = at.r.clone().normalize();
      const pD = at.r.clone().addScaledVector(rHat, miss0);
      const p = pD.clone().normalize();
      const Y = new Vector3(0, 1, 0);
      const e1 = Y.clone().addScaledVector(p, -Y.dot(p)).normalize();
      const e2 = new Vector3().crossVectors(p, e1);
      const cosTh = Math.max(-1, Math.min(1, Math.cos(98 * DEG) / Math.sqrt(1 - p.y * p.y)));
      const th = Math.acos(cosTh);
      const h = e1.multiplyScalar(Math.cos(th)).addScaledVector(e2, Math.sin(th)).normalize();
      const vD = new Vector3().crossVectors(h, p).multiplyScalar(Math.sqrt(MU / pD.length()));
      const back = propagateKepler(pD, vD, -this.tca);
      this.deb = { r0: back.r.clone(), v0: back.v.clone(), t0: game.simTime };
      this.tcaAbs = game.simTime + this.tca;
      this.r = new Vector3();
      this.v = new Vector3();
      this.updateDebris(game);
      game.extraTarget = { name: 'Debris fragment', kind: 'debris', r: this.r, v: this.v, closest: null };
      this.predicted = miss0;
      this.caTimer = 0;
      this.burnAt = null;
      this.passed = false;
      game.view.setDebrisVisible?.(true);
      game.objectives = [
        { text: 'Assess the conjunction (TCA, miss distance)', state: 'active' },
        { text: 'Avoidance burn: predicted miss ≥ 2 km', state: 'pending' },
        { text: 'Survive the pass', state: 'pending' },
      ];
    },
    updateDebris(game) {
      const st = propagateKepler(this.deb.r0, this.deb.v0, game.simTime - this.deb.t0);
      this.r.copy(st.r);
      this.v.copy(st.v);
    },
    update(game, dt) {
      const ship = game.ship;
      const o = game.objectives;
      this.updateDebris(game);
      const tLeft = this.tcaAbs - game.simTime;
      if (o[0].state === 'active' && game.missionTime > 3) {
        o[0].state = 'done';
        o[1].state = 'active';
        game.toast('Flight Dynamics: maneuver required — Pc above red threshold', 'warn');
        game.sfx?.('radio');
      }
      this.caTimer -= dt;
      if (tLeft > 1 && this.caTimer <= 0) {
        this.caTimer = 0.25;
        const ca = closestApproach(ship.r, ship.v, this.r, this.v, tLeft + 30, 200);
        this.predicted = ca.distance;
        game.extraTarget.closest = ca;
      }
      if (tLeft < 40 && tLeft > 0) game.stopWarp('Conjunction imminent');
      game.hint = tLeft > 0 ? `TCA ${Math.floor(tLeft / 60)}:${String(Math.floor(tLeft % 60)).padStart(2, '0')} · predicted miss ${this.predicted < 5000 ? this.predicted.toFixed(0) + ' m' : (this.predicted / 1000).toFixed(1) + ' km'}` : 'Fragment has passed';
      if (o[1].state === 'active' && this.predicted >= 2000 && ship.throttle === 0 && ship.transInput.lengthSq() === 0) {
        o[1].state = 'done';
        o[2].state = 'active';
        this.burnAt = tLeft;
        game.award(300 + Math.round(200 * clamp01(tLeft / this.tca)), 'Safe miss distance');
      }
      if (!this.passed && tLeft < -3) {
        this.passed = true;
        // exact miss distance: propagate both back across TCA
        const s0 = propagateKepler(ship.r, ship.v, -8);
        const d0 = propagateKepler(this.r, this.v, -8);
        const ca = closestApproach(s0.r, s0.v, d0.r, d0.v, 16, 400);
        this.missDistance = ca.distance;
        game.extraTarget.closest = null;
        if (ca.distance < 8) {
          ship.destroy('Struck by a debris fragment at ' + (ca.relSpeed / 1000).toFixed(1) + ' km/s');
        } else if (ca.distance < 1000) {
          o[2].state = 'failed';
          game.complete(false, `Fragment passed only ${ca.distance.toFixed(0)} m away — unacceptable risk`);
        } else {
          o[2].state = 'done';
          game.award(600, `Fragment passed at ${(ca.distance / 1000).toFixed(2)} km`);
          game.complete(true, `Miss distance ${(ca.distance / 1000).toFixed(2)} km`);
        }
      }
    },
    finalize(game) {
      const dv = game.ship.dvUsed + game.ship.rcsDvUsed;
      return [
        { label: `Margin (${(this.missDistance / 1000).toFixed(2)} km)`, points: Math.round(300 * clamp01((this.missDistance - 2000) / 3000)) },
        { label: `Δv economy (${dv.toFixed(1)} m/s)`, points: Math.round(400 * clamp01(1 - dv / 20)) },
        { label: `Early decision (${Math.round(this.burnAt ?? 0)} s before TCA)`, points: Math.round(200 * clamp01((this.burnAt ?? 0) / this.tca)) },
      ];
    },
  },
  // ------------------------------------------------------------------
  {
    id: 'reentry',
    title: 'Deorbit & Re-entry',
    tag: 'Module 7 · Return to Earth',
    difficulty: 4,
    stars: [1400, 2000, 2400],
    summary: 'Deorbit, jettison the service module, fly the lifting entry and land under parachutes.',
    briefing: [
      'Point RETROGRADE (key 3) and burn until periapsis is 40–60 km. Cut the engine.',
      'Jettison the service module with SPACE before 120 km. Keep the heat shield into the airflow (stay RETROGRADE).',
      'The capsule generates lift along its +Y (top). Roll heads-up (lift vector up) to keep g-load low — or toggle SAS auto-roll with U.',
      'SPACE again: drogue chutes below 12 km & 300 m/s. SPACE again: mains below 7 km & 150 m/s.',
      'Points: corridor accuracy, heat shield margin, peak g-load, splashdown speed.',
    ],
    setup(game) {
      const nu = sunlitNu(INC, RAAN, -2.4);
      const s = circular(420 * KM, nu);
      const ship = game.ship;
      ship.r.copy(s.r);
      ship.v.copy(s.v);
      pointShip(ship, s.v.clone().negate(), s.r);
      ship.setSasMode('retrograde');
      if (game.modifiers?.rcsScale) ship.rcsFuel *= game.modifiers.rcsScale;
      this.awarded = {};
      game.objectives = [
        { text: 'Deorbit burn: periapsis 40–60 km', state: 'active' },
        { text: 'Jettison service module above 120 km', state: 'pending' },
        { text: 'Survive entry (heat shield first, < 8 g)', state: 'pending' },
        { text: 'Deploy drogue chutes', state: 'pending' },
        { text: 'Deploy main chutes', state: 'pending' },
        { text: 'Splashdown < 9 m/s', state: 'pending' },
      ];
    },
    update(game) {
      const ship = game.ship;
      const o = game.objectives;
      const alt = ship.altitude;
      const el = elementsFromState(ship.r, ship.v);
      const pe = el.rp - R_EARTH;
      if (o[0].state === 'active') {
        game.hint = `Periapsis ${fmtKm(pe)} (target 40–60 km)`;
        if (pe < 75 * KM && ship.throttle === 0) {
          o[0].state = 'done';
          o[1].state = 'active';
          const err = Math.abs(pe - 50 * KM);
          const pts = pe < 20 * KM ? 50 : Math.round(150 + 250 * clamp01(1 - err / 25000));
          game.award(pts, `Deorbit burn — Pe ${fmtKm(pe)}`);
          this.deorbitPe = pe;
        }
      }
      if (o[1].state !== 'done' && ship.stage === 1) {
        o[1].state = 'done';
        o[2].state = 'active';
        if (alt > 120 * KM && ship.smDamage < 1) game.award(150, 'Clean separation');
        else game.award(0, 'Late separation');
        if (o[0].state !== 'done') o[0].state = 'failed';
      }
      if (o[2].state === 'active' || o[1].state === 'active') {
        if (alt < 140 * KM) game.hint = `Heat flux ${(ship.heatFlux / 1e4).toFixed(0)} W/cm² · ${ship.gForce.toFixed(1)} g · shield ${(ship.shield * 100).toFixed(0)}% · AoA ${(ship.aoaShield / DEG).toFixed(0)}°`;
        if (alt < 25 * KM && ship.stage === 1 && o[2].state === 'active') {
          o[2].state = 'done';
          o[3].state = 'active';
          game.award(300, 'Entry survived');
        }
      }
      if (ship.chute === 'drogue' && o[3].state !== 'done') {
        o[3].state = 'done';
        o[4].state = 'active';
        game.award(100, 'Drogues out');
      }
      if (ship.chute === 'main' && o[4].state !== 'done') {
        o[4].state = 'done';
        o[5].state = 'active';
        if (o[3].state !== 'done') o[3].state = 'failed';
        game.award(100, 'Mains out');
      }
      if (ship.chute === 'main' || ship.chute === 'drogue') game.hint = `Altitude ${alt.toFixed(0)} m · descent ${(-ship.verticalSpeed).toFixed(1)} m/s`;
      if (ship.landed) {
        if (ship.landingSpeed < 9) {
          o[5].state = 'done';
          game.award(600, 'Splashdown!');
          game.complete(true, `Splashdown at ${ship.landingSpeed.toFixed(1)} m/s`);
        } else {
          o[5].state = 'failed';
          game.complete(false, `Hard landing at ${ship.landingSpeed.toFixed(1)} m/s`);
        }
      }
      if (ship.maxG > 8 && o[2].state === 'active') {
        o[2].state = 'failed';
        game.penalize(300, `Peak load ${ship.maxG.toFixed(1)} g — lift vector down?`);
      }
    },
    finalize(game) {
      const ship = game.ship;
      return [
        { label: `Heat shield margin (${(ship.shield * 100).toFixed(0)}%)`, points: Math.round(300 * clamp01(ship.shield / 0.7)) },
        { label: `Peak g-load (${ship.maxG.toFixed(1)} g)`, points: ship.maxG < 4 ? 300 : ship.maxG < 6 ? 150 : 0 },
        { label: `Landing speed (${ship.landingSpeed.toFixed(1)} m/s)`, points: Math.round(200 * clamp01(1 - ship.landingSpeed / 10)) },
      ];
    },
  },
  // ------------------------------------------------------------------
  {
    id: 'free',
    title: 'Free Flight',
    tag: 'Sandbox',
    difficulty: 0,
    stars: [0, 0, 0],
    summary: 'No objectives — fly around the station, practise, or hang out with other pilots.',
    briefing: ['Free flight near the station. No scoring. Press P / Esc for the menu.'],
    hasStation: true,
    free: true,
    setup(game, slot = 0) {
      const nu = sunlitNu(INC, RAAN, -0.9);
      game.createStation({ a: R_EARTH + 420 * KM, i: INC, raan: RAAN, nu0: nu, t0: game.simTime });
      const st = game.station;
      const ship = game.ship;
      const axis = st.portAxis();
      const up = new Vector3(0, 1, 0).applyQuaternion(st.q);
      ship.r.copy(st.portWorld()).addScaledVector(axis, 250 + slot * 40).addScaledVector(up, 20 * slot);
      const omega = new Vector3().crossVectors(st.r, st.v).divideScalar(st.r.lengthSq());
      ship.v.copy(st.v).add(new Vector3().crossVectors(omega, ship.r.clone().sub(st.r)));
      pointShip(ship, axis.clone().negate(), up);
      ship.setSasMode('stability');
      game.objectives = [{ text: 'Explore. Dock if you like.', state: 'active' }];
    },
    update() {},
    onDock(game) {
      game.toast('Docked. Press SPACE... just kidding — enjoy the view.', 'info');
    },
    finalize() {
      return [];
    },
  },
];

export function getMission(id) {
  return MISSIONS.find((m) => m.id === id);
}

export const RANKS = [
  { min: 0, name: 'Cadet' },
  { min: 2500, name: 'Astronaut Candidate' },
  { min: 6000, name: 'Mission Specialist' },
  { min: 9000, name: 'Pilot Astronaut' },
  { min: 11000, name: 'Commander' },
  { min: 12500, name: 'Flight Director' },
];

export function rankFor(total) {
  let r = RANKS[0];
  for (const x of RANKS) if (total >= x.min) r = x;
  return r;
}

