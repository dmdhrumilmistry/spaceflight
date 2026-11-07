// AI / automation interface. Exposed as `window.orbitalAcademy` so LLM agents,
// browser-automation tools and scripts can read telemetry and fly the ship.
// Documented in public/llms.txt and AGENTS.md.
import { Vector3 } from 'three';
import { MISSIONS } from '../game/missions.js';
import { SAS_MODES } from '../sim/spacecraft.js';
import { elementsFromState, orbitalDirections } from '../sim/orbit.js';
import { R_EARTH } from '../sim/constants.js';
import { WARP_LEVELS } from '../game/game.js';

const DEG = 180 / Math.PI;
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const arr = (v, d = 3) => [round(v.x, d), round(v.y, d), round(v.z, d)];

export function telemetry(game) {
  const ship = game.ship;
  const el = elementsFromState(ship.r, ship.v);
  const fwd = ship.forward(new Vector3());
  const dirs = orbitalDirections(ship.r, ship.v);
  const ang = (d) => (d ? round(fwd.angleTo(d) * DEG, 2) : null);
  const tgt = game.target;
  const tdir = tgt ? game.targetPos().sub(ship.r).normalize() : null;
  const d = game.docking;
  return {
    state: game.state,
    mission: game.mission ? { id: game.missionId, title: game.mission.title } : null,
    objectives: game.objectives.map((o) => ({ text: o.text, state: o.state })),
    hint: game.hint,
    score: Math.round(game.result ? game.result.total : game.score),
    missionTimeS: round(game.missionTime, 1),
    warp: WARP_LEVELS[game.warpIndex],
    ship: {
      altitudeM: round(ship.altitude, 1),
      orbitalSpeedMs: round(ship.v.length(), 2),
      surfaceSpeedMs: ship.airVel ? round(ship.airVel.length(), 2) : null,
      verticalSpeedMs: round(ship.verticalSpeed, 2),
      apoapsisAltM: el.e < 1 ? round(el.ra - R_EARTH, 0) : null,
      periapsisAltM: round(el.rp - R_EARTH, 0),
      eccentricity: round(el.e, 5),
      inclinationDeg: round(el.i * DEG, 3),
      periodS: round(el.period, 1),
      timeToApoapsisS: round(el.timeToAp, 1),
      timeToPeriapsisS: round(el.timeToPe, 1),
      positionEciM: arr(ship.r, 1),
      velocityEciMs: arr(ship.v, 3),
      attitudeQuaternion: [round(ship.q.x, 5), round(ship.q.y, 5), round(ship.q.z, 5), round(ship.q.w, 5)],
      forwardEci: arr(fwd, 4),
      angularRateDegS: arr(ship.w.clone().multiplyScalar(DEG), 3),
      throttle: round(ship.throttle, 3),
      mainPropellantKg: round(ship.stage === 0 ? ship.fuel : 0, 1),
      rcsPropellantKg: round(ship.rcsFuel, 2),
      deltaVRemainingMs: round(ship.deltaV, 1),
      stage: ship.stage === 0 ? 'capsule+service-module' : 'capsule',
      parachutes: ship.chute,
      sas: { enabled: ship.sasEnabled, mode: ship.sasMode, locked: ship.sasLocked },
      rcsEnabled: ship.rcsEnabled,
      gForce: round(ship.gForce, 2),
      maxG: round(ship.maxG, 2),
      heatFluxWcm2: round(ship.heatFlux / 1e4, 1),
      heatShieldFraction: round(ship.shield, 3),
      inSunlight: ship.eclipse > 0.5,
      destroyed: ship.destroyed,
      landed: ship.landed,
    },
    pointingErrorDeg: {
      prograde: ang(dirs.prograde),
      retrograde: ang(dirs.prograde.clone().negate()),
      normal: ang(dirs.normal),
      antinormal: ang(dirs.normal.clone().negate()),
      radialOut: ang(dirs.radial),
      radialIn: ang(dirs.radial.clone().negate()),
      target: ang(tdir),
    },
    target: tgt
      ? {
          name: tgt.name,
          rangeM: round(ship.r.distanceTo(tgt.r), 1),
          relativeSpeedMs: round(ship.v.distanceTo(tgt.v), 3),
          closestApproach: game.closest ? { distanceM: round(game.closest.distance, 1), inS: round(game.closest.time, 1), relSpeedMs: round(game.closest.relSpeed, 2) } : null,
        }
      : null,
    docking: d
      ? {
          docked: !!game.docked,
          rangeM: round(d.range, 3),
          axialM: round(d.axial, 3),
          lateralM: round(d.lateral, 3),
          lateralXM: round(d.latX, 3),
          lateralYM: round(d.latY, 3),
          closingMs: round(d.closing, 4),
          angleDeg: round(d.angle, 3),
          yawErrorDeg: round(d.yawErr, 3),
          pitchErrorDeg: round(d.pitchErr, 3),
          rollDeg: round(d.roll, 2),
          captureLimits: { lateralM: 0.3, angleDeg: 5, rollDeg: 8, closingMs: 0.35 },
        }
      : null,
    result: game.result ? { success: game.result.success, reason: game.result.reason, total: game.result.total, stars: game.result.stars } : null,
  };
}

const HELP = `Orbital Academy agent API (window.orbitalAcademy)
- missions(): list modules {id,title,summary,briefing}
- start(id, {skipBriefing=true, daily}): start a module
- state(): full telemetry JSON (orbit, attitude, pointing errors to navball markers, target, docking, objectives, score)
- controls({pitch,yaw,roll,x,y,z,throttle}): continuous inputs in [-1,1] (throttle 0..1); persists until changed. pitch>0 nose up, yaw>0 nose left, roll>0 roll left, x>0 translate right, y>0 up, z<0 forward.
- command(name, value): 'sas' (bool) | 'sasMode' (${SAS_MODES.join('|')}) | 'stage' | 'warp' (level index 0..${WARP_LEVELS.length - 1}) | 'camera' | 'map' | 'rcs' (bool) | 'autoRoll' (bool) | 'pause' | 'resume' | 'undock'
- step(seconds): advance the simulation deterministically at 60 Hz without waiting for real time (rendering skipped), returns state()
- describe(): this text`;

export function installAgentApi({ game, input, start }) {
  input.agent = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0 };
  const api = {
    version: 1,
    describe: () => HELP,
    missions: () => MISSIONS.map((m) => ({ id: m.id, title: m.title, tag: m.tag, summary: m.summary, briefing: m.briefing, stars: m.stars })),
    start(id, { skipBriefing = true, daily = null } = {}) {
      if (!MISSIONS.some((m) => m.id === id)) throw new Error(`Unknown mission "${id}"`);
      start(id, { multiplayer: false, daily, modifiers: daily?.mods || null });
      if (skipBriefing) game.launch();
      return telemetry(game);
    },
    state: () => telemetry(game),
    controls(c = {}) {
      const a = input.agent;
      for (const k of ['pitch', 'yaw', 'roll', 'x', 'y', 'z']) if (c[k] !== undefined) a[k] = Math.max(-1, Math.min(1, Number(c[k]) || 0));
      if (c.throttle !== undefined) game.ship.throttle = Math.max(0, Math.min(1, Number(c.throttle) || 0));
      return { ...a, throttle: game.ship.throttle };
    },
    command(name, value) {
      const ship = game.ship;
      switch (name) {
        case 'sas':
          ship.sasEnabled = !!value && !ship.sasLocked;
          break;
        case 'sasMode':
          if (!SAS_MODES.includes(value)) throw new Error('sasMode must be one of ' + SAS_MODES.join(', '));
          ship.setSasMode(value);
          break;
        case 'stage':
          game.doStage();
          break;
        case 'undock':
          if (game.docked) game.undock();
          break;
        case 'warp':
          game.warpIndex = 0;
          game.changeWarp(Math.max(0, Math.min(WARP_LEVELS.length - 1, value | 0)));
          break;
        case 'camera':
          game.view.cycleCamera?.();
          break;
        case 'map':
          game.view.toggleMap?.();
          break;
        case 'rcs':
          ship.rcsEnabled = !!value;
          break;
        case 'autoRoll':
          ship.autoRoll = !!value;
          break;
        case 'pause':
          if (game.state === 'flying') game.state = 'paused';
          break;
        case 'resume':
          if (game.state === 'paused' || game.state === 'briefing') game.launch();
          break;
        default:
          throw new Error('Unknown command ' + name);
      }
      return telemetry(game);
    },
    step(seconds = 1) {
      const n = Math.max(1, Math.round(seconds * 60));
      game.skipRender = true;
      try {
        for (let i = 0; i < n && game.state !== 'menu'; i++) game.update(1 / 60);
      } finally {
        game.skipRender = false;
      }
      return telemetry(game);
    },
  };
  window.orbitalAcademy = api;
  return api;
}
