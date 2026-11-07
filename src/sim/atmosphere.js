import { Vector3 } from 'three';
import { EARTH_ROT, ATMO_TOP } from './constants.js';

// US Standard Atmosphere 1976 density samples (kg/m^3), log-interpolated.
const TABLE = [
  [0, 1.225],
  [5000, 0.7364],
  [10000, 0.4135],
  [15000, 0.1948],
  [20000, 0.08891],
  [25000, 0.04008],
  [30000, 0.01841],
  [40000, 0.003996],
  [50000, 0.001027],
  [60000, 3.097e-4],
  [70000, 8.283e-5],
  [80000, 1.846e-5],
  [90000, 3.416e-6],
  [100000, 5.604e-7],
  [110000, 9.708e-8],
  [120000, 2.222e-8],
  [130000, 8.152e-9],
  [140000, 3.831e-9],
  [150000, 2.076e-9],
];
const LOGS = TABLE.map(([h, d]) => [h, Math.log(d)]);

export function airDensity(alt) {
  if (alt >= ATMO_TOP) return 0;
  if (alt <= 0) return TABLE[0][1];
  for (let i = 1; i < LOGS.length; i++) {
    if (alt <= LOGS[i][0]) {
      const [h0, l0] = LOGS[i - 1];
      const [h1, l1] = LOGS[i];
      const f = (alt - h0) / (h1 - h0);
      return Math.exp(l0 + (l1 - l0) * f);
    }
  }
  return 0;
}

/** Speed of sound approximation (m/s) for Mach display. */
export function speedOfSound(alt) {
  if (alt < 11000) return 340.3 - 0.0041 * alt;
  if (alt < 20000) return 295;
  if (alt < 47000) return 295 + (alt - 20000) * 0.0011;
  if (alt < 71000) return 329 - (alt - 47000) * 0.0018;
  return 285;
}

const OMEGA = new Vector3(0, EARTH_ROT, 0);
/** Velocity relative to the co-rotating atmosphere. */
export function airVelocity(r, v, out = new Vector3()) {
  out.crossVectors(OMEGA, r);
  return out.subVectors(v, out);
}
