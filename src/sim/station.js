// Space station on an analytic circular orbit, LVLH attitude
// (docking port axis -Z faces prograde, +Y zenith).
import { Vector3, Quaternion, Matrix4 } from 'three';
import { MU } from './constants.js';
import { stateFromElements } from './orbit.js';

// Default port: IDA-2 on PMA-2, Harmony forward (see render/issModel.js)
export const STATION_PORT_LOCAL = new Vector3(0, 0, -20.6);

const m4 = new Matrix4();
const X = new Vector3();
const Y = new Vector3();
const Z = new Vector3();

export class Station {
  constructor({ a, i = 0, raan = 0, nu0 = 0, t0 = 0, colliders = [], portLocal = STATION_PORT_LOCAL, name = 'ISS' }) {
    this.portLocal = portLocal.clone();
    this.name = name;
    this.a = a;
    this.i = i;
    this.raan = raan;
    this.nu0 = nu0;
    this.t0 = t0;
    this.n = Math.sqrt(MU / (a * a * a));
    this.r = new Vector3();
    this.v = new Vector3();
    this.q = new Quaternion();
    this.colliders = colliders;
    this.update(t0);
  }

  stateAt(t, outR = new Vector3(), outV = new Vector3()) {
    const nu = this.nu0 + this.n * (t - this.t0);
    const s = stateFromElements({ a: this.a, e: 0, i: this.i, raan: this.raan, argp: 0, nu });
    outR.copy(s.r);
    outV.copy(s.v);
    return { r: outR, v: outV };
  }

  update(t) {
    this.stateAt(t, this.r, this.v);
    Z.copy(this.v).normalize().negate(); // local +Z points retrograde, port (-Z) prograde
    Y.copy(this.r).normalize();
    Y.addScaledVector(Z, -Y.dot(Z)).normalize();
    X.crossVectors(Y, Z);
    m4.makeBasis(X, Y, Z);
    this.q.setFromRotationMatrix(m4);
  }

  toLocal(world, out = new Vector3()) {
    return out.copy(world).sub(this.r).applyQuaternion(this.q.clone().invert());
  }
  toWorld(local, out = new Vector3()) {
    return out.copy(local).applyQuaternion(this.q).add(this.r);
  }
  portWorld(out = new Vector3()) {
    return this.toWorld(this.portLocal, out);
  }
  portAxis(out = new Vector3()) {
    return out.set(0, 0, -1).applyQuaternion(this.q);
  }

  /** Does a sphere (world centre, radius) intersect the station structure? */
  collides(centerWorld, radius) {
    const p = this.toLocal(centerWorld);
    for (const c of this.colliders) {
      const dx = Math.max(c.min.x - p.x, 0, p.x - c.max.x);
      const dy = Math.max(c.min.y - p.y, 0, p.y - c.max.y);
      const dz = Math.max(c.min.z - p.z, 0, p.z - c.max.z);
      if (dx * dx + dy * dy + dz * dz < radius * radius) return true;
    }
    return false;
  }
}
