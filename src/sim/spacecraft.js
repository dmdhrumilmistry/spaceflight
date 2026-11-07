// Rigid-body spacecraft dynamics: translation (RK4), attitude (RCS torques + SAS),
// propellant, atmospheric drag, aero stability, re-entry heating and parachutes.
import { Vector3, Quaternion } from 'three';
import { MU, R_EARTH, G0, ATMO_TOP } from './constants.js';
import { airDensity, airVelocity } from './atmosphere.js';
import { propagateKepler } from './orbit.js';

export const SHIP_SPEC = {
  name: 'Kestrel-II Trainer',
  capsuleDry: 5200,
  smDry: 3600,
  smFuel: 3400,
  rcsFuel: 240,
  mainThrust: 33000, // N
  mainIsp: 316, // s
  rcsForce: 900, // N per translation axis
  rcsIsp: 230,
  rcsTorque: [5600, 5600, 3800], // N*m about body X (pitch), Y (yaw), Z (roll)
  rcsLever: 2.2,
  inertiaFull: [52000, 52000, 30000],
  inertiaCapsule: [14500, 14500, 12500],
  diameter: 5.0,
  capsuleCd: 1.3,
  smCd: 0.9,
  noseOffset: 3.05, // CoM -> docking port tip along forward (-Z), see shipModel
  shieldCapacity: 2.5e8, // J/m^2 absorbable by ablative heat shield
  hullCapacity: 1.2e7, // J/m^2 before unprotected structure fails
  smCapacity: 4.0e7,
  drogueCdA: 70,
  mainCdA: 2450,
};

export const SAS_MODES = [
  'stability',
  'prograde',
  'retrograde',
  'normal',
  'antinormal',
  'radialOut',
  'radialIn',
  'target',
  'antiTarget',
];

const FWD = new Vector3(0, 0, -1);
const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();
const tmpL1 = new Vector3();
const tmpDir = new Vector3();
const tmpAero = new Vector3();
const tmpL2 = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();

function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

export class Spacecraft {
  constructor(spec = SHIP_SPEC) {
    this.spec = spec;
    this.r = new Vector3(R_EARTH + 400000, 0, 0);
    this.v = new Vector3(0, 0, -7670);
    this.q = new Quaternion();
    this.w = new Vector3(); // body rates rad/s
    this.reset();
  }

  reset() {
    const s = this.spec;
    this.stage = 0; // 0 = capsule + service module, 1 = capsule only
    this.fuel = s.smFuel;
    this.rcsFuel = s.rcsFuel;
    this.throttle = 0;
    this.rotInput = new Vector3(); // pitch, yaw, roll  [-1,1]
    this.transInput = new Vector3(); // body x (right), y (up), z (back)  [-1,1]
    this.rotCmd = new Vector3(); // final command after SAS mixing (for FX)
    this.transCmd = new Vector3();
    this.rcsEnabled = true;
    this.sasEnabled = true;
    this.sasMode = 'stability';
    this.sasLocked = false; // missions may lock SAS
    this.holdQ = null;
    this.precision = false;
    this.autoRoll = false; // SAS keeps lift vector up (heads-up) in direction modes
    this.chute = 'stowed'; // stowed | drogue | main | torn (drogue lost) | failed
    this.chuteDeploy = 0;
    this.shield = 1; // fraction remaining
    this.hullDamage = 0; // 0..1
    this.smDamage = 0;
    this.heatFlux = 0; // W/m^2
    this.heatLoad = 0;
    this.gForce = 0;
    this.maxG = 0;
    this.highGTime = 0;
    this.dynPressure = 0;
    this.mach = 0;
    this.aoaShield = 0; // angle between heat shield axis and airflow (rad)
    this.destroyed = false;
    this.destroyReason = '';
    this.landed = false;
    this.landingSpeed = 0;
    this.dvUsed = 0;
    this.rcsDvUsed = 0;
    this.rcsUsed = 0;
    this.mainUsed = 0;
    this.events = [];
    this.thrustActive = false;
    this.eclipse = 0;
  }

  get mass() {
    const s = this.spec;
    return s.capsuleDry + this.rcsFuel + (this.stage === 0 ? s.smDry + this.fuel : 0);
  }
  get inertia() {
    return this.stage === 0 ? this.spec.inertiaFull : this.spec.inertiaCapsule;
  }
  get verticalSpeed() {
    return this.v.dot(this.r) / this.r.length();
  }
  get altitude() {
    return this.r.length() - R_EARTH;
  }
  forward(out = new Vector3()) {
    return out.copy(FWD).applyQuaternion(this.q);
  }
  up(out = new Vector3()) {
    return out.set(0, 1, 0).applyQuaternion(this.q);
  }
  /** Remaining delta-v of the main propulsion system (m/s). */
  get deltaV() {
    if (this.stage !== 0) return 0;
    const m0 = this.mass;
    const m1 = m0 - this.fuel;
    return this.spec.mainIsp * G0 * Math.log(m0 / m1);
  }
  get canThrust() {
    return this.stage === 0 && this.fuel > 0 && !this.destroyed;
  }

  emit(type, msg, data) {
    this.events.push({ type, msg, data });
  }

  stageAction() {
    if (this.destroyed || this.landed) return;
    const alt = this.altitude;
    const speed = airVelocity(this.r, this.v, tmpA).length();
    if (this.stage === 0) {
      this.stage = 1;
      this.throttle = 0;
      this.emit('stage', 'Service module jettisoned');
      return;
    }
    if (this.chute === 'stowed') {
      if (alt > 14000 || speed > 300) {
        this.chute = 'torn';
        this.emit('fail', 'Drogue chutes torn — deployed too high/fast!');
      } else {
        this.chute = 'drogue';
        this.chuteDeploy = 0;
        this.emit('chute', 'Drogue chutes deployed');
      }
      return;
    }
    if (this.chute === 'drogue' || this.chute === 'torn') {
      if (alt > 7000) {
        this.emit('warn', 'Main chutes: wait until below 7 km');
        return;
      }
      if (speed > 150) {
        this.chute = 'failed';
        this.emit('fail', 'Main chutes torn — too fast (> 150 m/s)!');
        return;
      }
      this.chute = 'main';
      this.chuteDeploy = 0;
      this.emit('chute', 'Main chutes deployed');
    }
  }

  setSasMode(mode) {
    if (!SAS_MODES.includes(mode)) return;
    this.sasMode = mode;
    this.holdQ = null;
    if (!this.sasLocked) this.sasEnabled = true;
  }

  /** Desired forward direction (world) for a SAS mode, or null. */
  sasTargetDir(env) {
    const mode = this.sasMode;
    if (mode === 'stability') return null;
    const alt = this.altitude;
    const vel = alt < 70000 ? airVelocity(this.r, this.v, tmpB) : tmpB.copy(this.v);
    if (vel.lengthSq() < 1e-6) return null;
    const pro = vel.normalize();
    switch (mode) {
      case 'prograde':
        return tmpC.copy(pro);
      case 'retrograde':
        return tmpC.copy(pro).negate();
      case 'normal':
      case 'antinormal': {
        tmpC.crossVectors(this.r, this.v).normalize();
        return mode === 'normal' ? tmpC : tmpC.negate();
      }
      case 'radialOut':
      case 'radialIn': {
        const n = tmpA.crossVectors(this.r, this.v).normalize();
        tmpC.crossVectors(n, pro).normalize(); // radial out (in plane, perpendicular to velocity)
        return mode === 'radialOut' ? tmpC : tmpC.negate();
      }
      case 'target':
      case 'antiTarget': {
        if (!env || !env.targetPos) return null;
        tmpC.subVectors(env.targetPos, this.r);
        if (tmpC.lengthSq() < 1e-6) return null;
        tmpC.normalize();
        return mode === 'target' ? tmpC : tmpC.negate();
      }
    }
    return null;
  }

  /** Compute rotational command from pilot input + SAS. */
  computeRotationCommand(env) {
    const inp = this.rotInput;
    const scale = this.precision ? 0.25 : 1;
    const cmd = this.rotCmd.set(inp.x * scale, inp.y * scale, inp.z * scale);
    const anyInput = inp.lengthSq() > 0;
    if (!this.sasEnabled || !this.rcsEnabled) {
      this.holdQ = null;
      return cmd;
    }
    const I = this.inertia;
    const T = this.spec.rcsTorque;
    const wDes = tmpA.set(0, 0, 0);
    const dirRef = this.sasTargetDir(env);
    const dir = dirRef ? tmpDir.copy(dirRef) : null; // copy: sasTargetDir returns a shared temp
    const maxRate = 0.25;
    const rateFor = (angle, axis) => {
      const alpha = T[axis] / I[axis];
      return Math.min(maxRate, Math.sqrt(2 * alpha * Math.abs(angle)) * 0.7, Math.abs(angle) * 1.6) * Math.sign(angle);
    };
    if (dir) {
      const f = this.forward(tmpB);
      const axisW = tmpC.crossVectors(f, dir);
      const s = axisW.length();
      const c = f.dot(dir);
      const angle = Math.atan2(s, c);
      if (s > 1e-9) axisW.divideScalar(s);
      else if (c < 0) axisW.set(1, 0, 0).applyQuaternion(this.q); // 180deg: pick pitch axis
      // to body frame
      tmpQ.copy(this.q).invert();
      axisW.applyQuaternion(tmpQ);
      let rollRate = 0;
      if (this.autoRoll) {
        // roll so body +Y points "heads up" (away from Earth) => lift vector up
        const radial = tmpL1.copy(this.r).normalize();
        const fw = this.forward(tmpL2);
        radial.addScaledVector(fw, -radial.dot(fw));
        if (radial.lengthSq() > 1e-8) {
          radial.normalize().applyQuaternion(tmpQ); // body frame (tmpQ = q^-1)
          const rollErr = Math.atan2(-radial.x, radial.y); // angle from +Y about +Z
          rollRate = rateFor(rollErr, 2);
        }
      }
      wDes.set(rateFor(axisW.x * angle, 0), rateFor(axisW.y * angle, 1), rollRate);
      this.holdQ = null;
    } else {
      if (anyInput) this.holdQ = null;
      if (!this.holdQ && !anyInput && this.w.length() < 0.003) this.holdQ = this.q.clone();
      if (this.holdQ) {
        tmpQ.copy(this.q).invert().multiply(this.holdQ); // body-frame error
        if (tmpQ.w < 0) {
          tmpQ.x = -tmpQ.x;
          tmpQ.y = -tmpQ.y;
          tmpQ.z = -tmpQ.z;
          tmpQ.w = -tmpQ.w;
        }
        const angle = 2 * Math.acos(clamp(tmpQ.w, -1, 1));
        const sn = Math.sqrt(1 - tmpQ.w * tmpQ.w);
        if (sn > 1e-9) {
          wDes.set(
            rateFor((tmpQ.x / sn) * angle, 0),
            rateFor((tmpQ.y / sn) * angle, 1),
            rateFor((tmpQ.z / sn) * angle, 2),
          );
        }
      }
    }
    const tau = 0.35;
    const sasCmd = tmpB.set(
      ((wDes.x - this.w.x) * I[0]) / (T[0] * tau),
      ((wDes.y - this.w.y) * I[1]) / (T[1] * tau),
      ((wDes.z - this.w.z) * I[2]) / (T[2] * tau),
    );
    const dead = 0.02;
    if (inp.x === 0) cmd.x = Math.abs(sasCmd.x) < dead ? 0 : clamp(sasCmd.x, -1, 1);
    if (inp.y === 0) cmd.y = Math.abs(sasCmd.y) < dead ? 0 : clamp(sasCmd.y, -1, 1);
    if (inp.z === 0) cmd.z = Math.abs(sasCmd.z) < dead ? 0 : clamp(sasCmd.z, -1, 1);
    return cmd;
  }

  /** Non-gravitational acceleration from aerodynamics (world), updates aero state. */
  aeroAccel(r, v, out) {
    out.set(0, 0, 0);
    const alt = r.length() - R_EARTH;
    if (alt > ATMO_TOP) return out;
    const rho = airDensity(alt);
    if (rho <= 0) return out;
    const va = airVelocity(r, v, tmpC);
    const speed = va.length();
    if (speed < 1e-3) return out;
    const s = this.spec;
    const area = Math.PI * (s.diameter / 2) ** 2;
    let cda = (this.stage === 0 ? s.smCd * 1.15 : s.capsuleCd) * area;
    const dep = Math.min(1, this.chuteDeploy);
    if (this.chute === 'drogue') cda += s.drogueCdA * dep * dep;
    if (this.chute === 'main') cda += s.mainCdA * dep * dep + s.drogueCdA * 0.2;
    const q = 0.5 * rho * speed * speed;
    out.copy(va).multiplyScalar((-q * cda) / (this.mass * speed));
    // Capsule lift: offset centre of mass trims the capsule so it produces
    // L/D ~ 0.3 along body +Y (perpendicular to the airflow). Rolling the
    // capsule steers the lift vector — keep it "up" to reduce g-load.
    if (this.stage === 1 && this.chute === 'stowed' && this.aoaShield < 0.6) {
      const up = tmpL1.set(0, 1, 0).applyQuaternion(this.q);
      const vhat = tmpL2.copy(va).divideScalar(speed);
      up.addScaledVector(vhat, -up.dot(vhat));
      const ul = up.length();
      if (ul > 1e-6) {
        const liftAcc = (q * s.capsuleCd * area * 0.3) / this.mass;
        out.addScaledVector(up, liftAcc / ul);
      }
    }
    return out;
  }

  /** Total acceleration for RK4 (thrust vector held constant across the step). */
  accel(r, v, thrustAcc, out) {
    const rm = r.length();
    out.copy(r).multiplyScalar(-MU / (rm * rm * rm));
    out.add(thrustAcc);
    const aero = this.aeroAccel(r, v, tmpAero);
    return out.add(aero);
  }

  /**
   * Integrate one fixed physics step.
   * env: { targetPos, targetVel, allowSAS }
   */
  step(dt, env) {
    if (this.destroyed || this.landed) return;
    const s = this.spec;
    const I = this.inertia;

    // ----- attitude -----
    const rot = this.rcsEnabled && this.rcsFuel > 0 ? this.computeRotationCommand(env) : this.rotCmd.set(0, 0, 0);
    const T = s.rcsTorque;
    const wdot = tmpB.set((rot.x * T[0]) / I[0], (rot.y * T[1]) / I[1], (rot.z * T[2]) / I[2]);

    // aerodynamic stability torque (capsule is stable heat-shield first)
    const alt = this.altitude;
    const va = airVelocity(this.r, this.v, new Vector3());
    const vam = va.length();
    const rho = airDensity(alt);
    this.dynPressure = 0.5 * rho * vam * vam;
    if (this.dynPressure > 1 && vam > 1) {
      tmpQ.copy(this.q).invert();
      const vb = va.clone().applyQuaternion(tmpQ).divideScalar(vam); // airflow in body frame
      const back = new Vector3(0, 0, 1);
      this.aoaShield = Math.acos(clamp(back.dot(vb), -1, 1));
      const area = Math.PI * (s.diameter / 2) ** 2;
      let k = this.stage === 0 ? -0.15 : 0.6; // SM attached: weakly unstable
      if (this.chute === 'drogue' || this.chute === 'main') k = 2.5;
      const axis = back.cross(vb); // rotate +Z toward airflow
      const torque = axis.multiplyScalar(k * this.dynPressure * area * s.diameter * 0.12);
      wdot.x += torque.x / I[0];
      wdot.y += torque.y / I[1];
      wdot.z += torque.z / I[2];
      // aero damping
      const damp = (this.dynPressure * area * s.diameter * s.diameter * 0.05) / vam;
      wdot.x -= (damp * this.w.x) / I[0];
      wdot.y -= (damp * this.w.y) / I[1];
      wdot.z -= (damp * 0.2 * this.w.z) / I[2];
    } else {
      this.aoaShield = 0;
    }
    this.w.addScaledVector(wdot, dt);
    const wm = this.w.length();
    if (wm > 1e-12) {
      tmpQ2.setFromAxisAngle(tmpC.copy(this.w).divideScalar(wm), wm * dt);
      this.q.multiply(tmpQ2).normalize();
    }

    // ----- propellant & thrust -----
    const mass = this.mass;
    const thrustAcc = new Vector3();
    let mainOn = false;
    if (this.throttle > 0 && this.canThrust) {
      const F = s.mainThrust * this.throttle;
      const mdot = F / (s.mainIsp * G0);
      const burn = Math.min(this.fuel, mdot * dt);
      const Feff = (burn / dt) * s.mainIsp * G0;
      this.fuel -= burn;
      this.mainUsed += burn;
      thrustAcc.copy(FWD).applyQuaternion(this.q).multiplyScalar(Feff / mass);
      this.dvUsed += (Feff / mass) * dt;
      mainOn = Feff > 0;
      if (this.fuel <= 0) this.emit('warn', 'Main propellant depleted');
    }
    this.thrustActive = mainOn;
    // RCS translation
    const trans = this.transCmd.set(0, 0, 0);
    if (this.rcsEnabled && this.rcsFuel > 0) {
      trans.copy(this.transInput).multiplyScalar(this.precision ? 0.3 : 1);
      const tm = Math.abs(trans.x) + Math.abs(trans.y) + Math.abs(trans.z);
      if (tm > 0) {
        const F = s.rcsForce;
        const tw = tmpA.copy(trans).applyQuaternion(this.q).multiplyScalar(F / mass);
        thrustAcc.add(tw);
        this.rcsDvUsed += tw.length() * dt;
        const flow = (tm * F) / (s.rcsIsp * G0);
        this.consumeRcs(flow * dt);
      }
      // rotation propellant
      const rm = Math.abs(rot.x) * T[0] + Math.abs(rot.y) * T[1] + Math.abs(rot.z) * T[2];
      if (rm > 0) this.consumeRcs(((rm / s.rcsLever) / (s.rcsIsp * G0)) * dt * 0.5);
    }

    // ----- translation: RK4 -----
    const r0 = this.r.clone();
    const v0 = this.v.clone();
    const a1 = this.accel(r0, v0, thrustAcc, new Vector3());
    const r2 = r0.clone().addScaledVector(v0, dt / 2);
    const v2 = v0.clone().addScaledVector(a1, dt / 2);
    const a2 = this.accel(r2, v2, thrustAcc, new Vector3());
    const r3 = r0.clone().addScaledVector(v2, dt / 2);
    const v3 = v0.clone().addScaledVector(a2, dt / 2);
    const a3 = this.accel(r3, v3, thrustAcc, new Vector3());
    const r4 = r0.clone().addScaledVector(v3, dt);
    const v4 = v0.clone().addScaledVector(a3, dt);
    const a4 = this.accel(r4, v4, thrustAcc, new Vector3());
    this.r.addScaledVector(v0, dt / 6).addScaledVector(v2, dt / 3).addScaledVector(v3, dt / 3).addScaledVector(v4, dt / 6);
    this.v.addScaledVector(a1, dt / 6).addScaledVector(a2, dt / 3).addScaledVector(a3, dt / 3).addScaledVector(a4, dt / 6);

    // felt acceleration (g-load)
    const aero = this.aeroAccel(this.r, this.v, new Vector3());
    const felt = aero.add(thrustAcc).length();
    // low-pass for display
    this.gForce += (felt / G0 - this.gForce) * Math.min(1, dt * 8);
    this.maxG = Math.max(this.maxG, this.gForce);
    if (this.gForce > 12) {
      this.highGTime += dt;
      if (this.highGTime > 2.0) this.destroy('Crew incapacitated by excessive g-load (> 12 g)');
    } else this.highGTime = Math.max(0, this.highGTime - dt);

    // chutes
    if (this.chute === 'drogue' || this.chute === 'main') {
      this.chuteDeploy += dt / (this.chute === 'main' ? 6 : 3);
    }

    this.updateHeating(dt, rho, vam);

    // ground contact
    const newAlt = this.altitude;
    if (newAlt <= 0) {
      const sp = airVelocity(this.r, this.v, tmpA).length();
      this.landingSpeed = sp;
      if (sp < 12 && this.stage === 1) {
        this.landed = true;
        this.emit('landed', `Splashdown at ${sp.toFixed(1)} m/s`);
      } else {
        this.destroy(`Impact with surface at ${sp.toFixed(0)} m/s`);
      }
      // snap to surface & stop
      this.r.setLength(R_EARTH);
      this.v.set(0, 0, 0);
    }
    this.mach = vam / 300;
  }

  updateHeating(dt, rho, vam) {
    const s = this.spec;
    if (rho <= 0) {
      this.heatFlux = 0;
      return;
    }
    // Sutton-Graves stagnation heating, nose radius ~ 2.5 m
    const q = 1.7415e-4 * Math.sqrt(rho / 2.5) * vam * vam * vam;
    this.heatFlux = q;
    this.heatLoad += q * dt;
    if (q < 2e4) return;
    if (this.stage === 0) {
      this.smDamage += (q * dt) / s.smCapacity;
      if (this.smDamage >= 1) {
        this.stage = 1;
        this.w.add(new Vector3(0.4, -0.3, 0.6));
        this.emit('fail', 'Service module burned up during re-entry! Capsule tumbling');
      }
      return;
    }
    const aoa = (this.aoaShield * 180) / Math.PI;
    const protect = aoa < 25 ? 1 : aoa > 50 ? 0 : 1 - (aoa - 25) / 25;
    if (this.shield > 0) this.shield -= (q * dt * protect) / s.shieldCapacity;
    const unprotected = this.shield > 0 ? 1 - protect : 1;
    this.hullDamage += (q * dt * unprotected) / s.hullCapacity;
    if (this.shield < 0) this.shield = 0;
    if (this.hullDamage >= 1) this.destroy('Capsule burned up — heat shield not facing the airflow');
  }

  consumeRcs(amount) {
    const used = Math.min(this.rcsFuel, amount);
    this.rcsFuel -= used;
    this.rcsUsed += used;
    if (this.rcsFuel <= 0 && used > 0) this.emit('warn', 'RCS propellant depleted');
  }

  destroy(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyReason = reason;
    this.throttle = 0;
    this.emit('destroyed', reason);
  }

  /** Coast on Keplerian rails for large time warps. */
  propagateRails(dt, env) {
    propagateKepler(this.r, this.v, dt, MU, this.r, this.v);
    this.w.set(0, 0, 0);
    if (this.sasEnabled) {
      const dir = this.sasTargetDir(env);
      if (dir) {
        // snap attitude so forward = dir, keeping roll as close as possible
        const f = this.forward(new Vector3());
        tmpQ.setFromUnitVectors(f, dir);
        this.q.premultiply(tmpQ).normalize();
      }
    }
  }

  /** Can we warp on rails (no thrust, no atmosphere)? */
  canRails() {
    return (
      !this.destroyed &&
      !this.landed &&
      this.throttle === 0 &&
      this.transInput.lengthSq() === 0 &&
      this.rotInput.lengthSq() === 0 &&
      this.altitude > ATMO_TOP
    );
  }

  /** Serializable snapshot for networking. */
  snapshot() {
    return {
      r: [this.r.x, this.r.y, this.r.z],
      v: [this.v.x, this.v.y, this.v.z],
      q: [this.q.x, this.q.y, this.q.z, this.q.w],
      th: this.throttle,
      st: this.stage,
      ch: this.chute,
      hf: this.heatFlux,
      d: this.destroyed ? 1 : 0,
    };
  }
}
