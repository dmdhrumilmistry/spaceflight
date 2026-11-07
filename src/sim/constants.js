// Physical constants (SI units). World frame: Earth-centred inertial,
// +Y = north pole, Earth spins about +Y (eastward at +X is -Z).
export const MU = 3.986004418e14; // Earth gravitational parameter m^3/s^2
export const R_EARTH = 6371000; // mean radius, m
export const EARTH_ROT = 7.2921159e-5; // sidereal rotation rate rad/s
export const G0 = 9.80665;
export const ATMO_TOP = 150000; // drag/heating ignored above this altitude
export const ATMO_VISUAL_HEIGHT = 100000; // scattering shell
export const CLOUD_HEIGHT = 6000;
// Direction to the Sun in the inertial frame (fixed during a session)
export const SUN_DIR = (() => {
  const v = [0.82, 0.28, -0.5];
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
})();
