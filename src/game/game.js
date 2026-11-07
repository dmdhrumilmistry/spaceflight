// Game controller: mission lifecycle, time warp, physics stepping, docking &
// collision, scoring, multiplayer state exchange and per-frame rendering.
import { Vector3, Quaternion, Matrix4 } from 'three';
import { Spacecraft, SAS_MODES } from '../sim/spacecraft.js';
import { Station } from '../sim/station.js';
import { propagateKepler, orbitalDirections, elementsFromState, closestApproach } from '../sim/orbit.js';
import { airVelocity } from '../sim/atmosphere.js';
import { ATMO_TOP } from '../sim/constants.js';
import { getMission } from './missions.js';
import { checkAchievements } from './achievements.js';

export const WARP_LEVELS = [1, 2, 5, 10, 50, 100, 500, 1000];
const PHYS_DT = 1 / 60;
const MAX_PHYS_WARP = 10;
const DEG = Math.PI / 180;

export class Game {
  constructor({ view, hud, input, net, progress }) {
    this.view = view;
    this.hud = hud;
    this.input = input;
    this.net = net;
    this.progress = progress;
    this.state = 'menu';
    this.ship = new Spacecraft();
    this.station = null;
    this.simTime = 0;
    this.missionTime = 0;
    this.warpIndex = 0;
    this.score = 0;
    this.scoreLog = [];
    this.objectives = [];
    this.hint = '';
    this.docked = null;
    this.docking = null;
    this.remotes = new Map();
    this.netTimer = 0;
    this.caTimer = 0;
    this.closest = null;
    this.mission = null;
    this.multiplayer = false;
    this.result = null;
    this.menuOrbit = 0;
    this.lastOrbitUpdate = 0;
    this.bindInput();
  }

  // ------------------------------------------------------------------ setup
  start(missionId, { slot = 0, multiplayer = false, modifiers = null, daily = null } = {}) {
    const def = getMission(missionId);
    this.modifiers = modifiers;
    this.daily = daily;
    this.extraTarget = null;
    this.mission = Object.create(def);
    this.missionId = missionId;
    this.multiplayer = multiplayer;
    this.slot = slot;
    this.ship = new Spacecraft();
    this.station = null;
    this.view.setStation(false);
    this.simTime = 0;
    this.missionTime = 0;
    this.warpIndex = 0;
    this.score = 0;
    this.scoreLog = [];
    this.objectives = [];
    this.hint = '';
    this.docked = null;
    this.docking = null;
    this.closest = null;
    this.result = null;
    this.view.camMode = 'chase';
    this.view.orbitCam = { yaw: 2.6, pitch: 0.18, dist: 28 };
    this.view.debris.forEach((d) => this.view.scene.remove(d.object));
    this.view.setDebrisVisible?.(false);
    this.view.debris = [];
    this.mission.setup(this, slot);
    if (this.station) this.station.update(this.simTime);
    this.state = 'briefing';
    this.view.updateOrbitLine('ship', this.ship.r, this.ship.v, true);
    this.hud.showBriefing(this.mission, () => this.launch());
  }

  launch() {
    this.state = 'flying';
    this.hud.hideOverlays();
    this.toast(this.mission.title + ' — go for operations', 'info');
    this.sfx('go');
    this.audio?.setMood('cruise');
  }

  createStation(params) {
    this.view.setStation(true);
    this.station = new Station({ ...params, colliders: this.view.station.colliders, portLocal: this.view.station.portLocal });
  }

  // ------------------------------------------------------------------ scoring
  award(points, label) {
    if (this.mission?.free) return;
    this.combo = (this.combo || 0) + 1;
    this.score += points;
    this.scoreLog.push({ label, points });
    this.hud.popup(`+${points}`, label, 'good', this.combo);
    this.sfx(points >= 500 ? 'bigscore' : 'score', { intensity: Math.min(1, points / 800) });
  }

  penalize(points, label) {
    if (this.mission?.free) return;
    this.combo = 0;
    this.score -= points;
    this.scoreLog.push({ label, points: -points });
    this.hud.popup(`−${points}`, label, 'bad');
    this.sfx('warning');
  }

  toast(msg, type = 'info') {
    this.hud.toast(msg, type);
  }

  sfx(name, opts) {
    try {
      this.audio?.play(name, opts);
    } catch {
      /* audio is optional */
    }
  }

  complete(success, reason) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.warpIndex = 0;
    const bonuses = success ? this.mission.finalize(this) : [];
    let total = this.score + bonuses.reduce((s, b) => s + b.points, 0);
    if (!success) total = Math.max(0, Math.round(this.score * 0.25));
    total = Math.max(0, Math.round(total));
    const stars = this.mission.stars.filter((s) => success && total >= s && s > 0).length;
    const prev = this.progress.best(this.missionId);
    const isBest = !this.mission.free && success && total > (prev?.score || 0);
    let rec = { xpGained: 0, levelUp: 0 };
    let unlocked = [];
    if (!this.mission.free) {
      rec = this.progress.record(this.missionId, { score: success ? total : 0, stars, success, daily: this.daily?.key });
      const m = this.mission;
      unlocked = checkAchievements({
        progress: this.progress,
        mission: this.missionId,
        success,
        free: !!m.free,
        stars,
        time: this.missionTime,
        dvUsed: this.ship.dvUsed,
        idealDv: m.idealDv,
        contact: m.contact,
        eclipse: this.ship.eclipse,
        maxG: this.ship.maxG,
        shield: this.ship.shield,
        missDistance: m.missDistance,
        destroyed: this.ship.destroyed,
        daily: !!this.daily,
        multiplayer: this.multiplayer,
      });
    }
    this.result = {
      success,
      reason,
      total,
      stars,
      bonuses,
      log: this.scoreLog.slice(),
      isBest,
      xpGained: rec.xpGained,
      levelUp: rec.levelUp,
      achievements: unlocked,
      daily: this.daily,
    };
    if (this.net && this.net.active) {
      this.net.send({ t: 'result', score: total, success, reason, mission: this.missionId });
    }
    if (success && !this.mission.free && this.onScore) {
      this.onScore({ board: this.missionId, mission: this.missionId, score: total, stars, improved: isBest });
      if (this.daily) this.onScore({ board: this.daily.board, mission: this.missionId, score: total, stars, improved: true });
    }
    this.audio?.setMood(success ? 'victory' : 'defeat');
    this.sfx(success ? 'success' : 'fail');
    setTimeout(() => {
      this.hud.showResult(this.mission, this.result);
      unlocked.forEach((a, i) => setTimeout(() => this.hud.achievement(a), 600 + i * 1400));
      if (rec.levelUp) setTimeout(() => this.sfx('levelup'), 400);
      unlocked.forEach((a, i) => setTimeout(() => this.sfx('achievement'), 600 + i * 1400));
    }, success ? 1200 : 800);
  }

  stopWarp(reason) {
    if (this.warpIndex > 0) {
      this.warpIndex = 0;
      if (reason) this.toast(`Time warp stopped: ${reason}`, 'info');
    }
  }

  // ------------------------------------------------------------------ input
  bindInput() {
    this.input.onKey((code, e, uiOnly) => {
      if (code === 'Escape' || code === 'KeyP') {
        if (this.state === 'flying') {
          this.state = 'paused';
          this.hud.showPause();
        } else if (this.state === 'paused') {
          this.state = 'flying';
          this.hud.hideOverlays();
        }
        return;
      }
      if (uiOnly) return;
      if (code === 'Enter' && this.multiplayer) {
        this.hud.openChat();
        return;
      }
      if (code === 'F1' || code === 'Slash') {
        this.hud.toggleHelp();
        return;
      }
      if (this.state !== 'flying' && this.state !== 'ended') return;
      const ship = this.ship;
      switch (code) {
        case 'KeyT':
          if (ship.sasLocked) this.toast('SAS unavailable', 'bad');
          else ship.sasEnabled = !ship.sasEnabled;
          break;
        case 'KeyG':
          ship.rcsEnabled = !ship.rcsEnabled;
          break;
        case 'KeyU':
          ship.autoRoll = !ship.autoRoll;
          this.toast(`SAS auto-roll (lift up) ${ship.autoRoll ? 'ON' : 'OFF'}`, 'info');
          break;
        case 'Backquote':
          ship.precision = !ship.precision;
          this.toast(`Precision controls ${ship.precision ? 'ON' : 'OFF'}`, 'info');
          break;
        case 'KeyZ':
          ship.throttle = 1;
          break;
        case 'KeyX':
          ship.throttle = 0;
          break;
        case 'Space':
          if (this.docked) {
            this.undock();
            break;
          }
          if (ship.stage === 0 && !confirmStage(this)) break;
          this.doStage();
          break;
        case 'KeyV':
          this.view.cycleCamera();
          break;
        case 'KeyM':
          this.view.toggleMap();
          break;
        case 'Period':
          this.changeWarp(1);
          break;
        case 'Comma':
          this.changeWarp(-1);
          break;
        case 'Digit0':
          this.warpIndex = 0;
          break;
        default:
          if (code.startsWith('Digit')) {
            const n = parseInt(code.slice(5), 10);
            if (n >= 1 && n <= 9) {
              if (ship.sasLocked) this.toast('SAS unavailable', 'bad');
              else if ((n === 8 || n === 9) && !this.target) this.toast('No target selected', 'bad');
              else ship.setSasMode(SAS_MODES[n - 1]);
            }
          }
      }
    });
    this.input.onDrag = (dx, dy) => this.view.orbitInput(dx, dy);
    this.input.onZoom = (d) => this.view.zoomInput(d);
  }

  doStage() {
    const ship = this.ship;
    const wasStage = ship.stage;
    ship.stageAction();
    if (wasStage === 0 && ship.stage === 1) this.spawnSmDebris();
  }

  spawnSmDebris() {
    const obj = this.view.shipModel.detachServiceModule();
    const sep = new Vector3(0, 0, 1).applyQuaternion(this.ship.q).multiplyScalar(1.2);
    this.view.spawnDebris(obj, this.ship.r, this.ship.v.clone().add(sep), this.ship.q);
  }

  undock() {
    const st = this.station;
    this.docked = null;
    this.ship.v.addScaledVector(st.portAxis(), 0.15);
    this.toast('Undocked', 'info');
  }

  changeWarp(dir) {
    const next = Math.max(0, Math.min(WARP_LEVELS.length - 1, this.warpIndex + dir));
    if (dir > 0 && WARP_LEVELS[next] > MAX_PHYS_WARP && !this.canRailWarp()) {
      this.toast('Cannot warp faster: engine/RCS active, in atmosphere, or near the station', 'bad');
      this.warpIndex = Math.min(next, WARP_LEVELS.indexOf(MAX_PHYS_WARP));
      return;
    }
    this.warpIndex = next;
  }

  canRailWarp() {
    if (this.docked) return true;
    if (!this.ship.canRails()) return false;
    if (this.station && this.station.r.distanceTo(this.ship.r) < 3000) return false;
    return true;
  }

  // ------------------------------------------------------------------ loop
  update(realDt) {
    const dt = Math.min(realDt, 0.1);
    if (this.state === 'menu') {
      this.renderMenuBackground(dt);
      return;
    }
    const ship = this.ship;
    const flying = this.state === 'flying';
    const ended = this.state === 'ended';

    if (flying || ended) this.readControls(dt);
    else {
      ship.rotInput.set(0, 0, 0);
      ship.transInput.set(0, 0, 0);
    }

    let warp = flying || ended ? WARP_LEVELS[this.warpIndex] : 0;
    if (warp > MAX_PHYS_WARP && !this.canRailWarp()) {
      this.warpIndex = WARP_LEVELS.indexOf(MAX_PHYS_WARP);
      warp = MAX_PHYS_WARP;
    }
    // drop out of warp when entering the atmosphere
    if (warp > 1 && ship.altitude < ATMO_TOP + 5000 && ship.altitude > 90000 && this.prevAlt > ATMO_TOP + 5000) {
      this.stopWarp('Entering the atmosphere');
      warp = 1;
    }
    this.prevAlt = ship.altitude;
    const simDt = dt * warp;
    const env = this.sasEnv();

    if (simDt > 0) {
      if (this.docked) {
        this.simTime += simDt;
        this.station.update(this.simTime);
        this.applyDockedPose();
      } else if (warp > MAX_PHYS_WARP) {
        ship.propagateRails(simDt, env);
        this.simTime += simDt;
        if (this.station) this.station.update(this.simTime);
      } else {
        const n = Math.max(1, Math.ceil(simDt / PHYS_DT - 1e-6));
        const h = simDt / n;
        for (let k = 0; k < n; k++) {
          ship.step(h, env);
          this.simTime += h;
          if (this.station) {
            this.station.update(this.simTime);
            env.targetPos = this.targetPos();
            this.checkProximity();
            if (this.docked) break;
          }
        }
      }
      this.missionTime += simDt;
    }
    ship.airVel = airVelocity(ship.r, ship.v);

    // events from the spacecraft
    for (const ev of ship.events) {
      if (ev.type === 'fail') {
        this.toast(ev.msg, 'bad');
        this.penalize(100, ev.msg.split(' — ')[0]);
      } else if (ev.type === 'warn') {
        this.toast(ev.msg, 'warn');
        this.sfx('warning');
      } else if (ev.type === 'destroyed') {
        this.toast(ev.msg, 'bad');
        this.sfx('alarm');
      } else this.toast(ev.msg, 'info');
      if (ev.type === 'stage') this.sfx('stage');
      else if (ev.type === 'chute') this.sfx('chute');
      else if (ev.type === 'landed') this.sfx('splash');
      if (ev.type !== 'warn') this.stopWarp();
    }
    ship.events.length = 0;

    if (flying) {
      if (ship.destroyed) this.complete(false, ship.destroyReason);
      else this.mission.update(this, simDt);
      if (ship.landed && this.state === 'flying' && this.missionId !== 'reentry') this.complete(true, 'Landed');
    }

    // closest approach (2 Hz)
    this.caTimer -= dt;
    const tgt = this.target;
    if (tgt && this.caTimer <= 0) {
      this.caTimer = 0.5;
      const dist = ship.r.distanceTo(tgt.r);
      if (tgt.closest) this.closest = tgt.closest;
      else if (dist > 1500 && ship.altitude > ATMO_TOP) {
        const el = elementsFromState(ship.r, ship.v);
        const win = Math.min(isFinite(el.period) ? el.period : 6000, 7000);
        this.closest = closestApproach(ship.r, ship.v, tgt.r, tgt.v, win, 160);
      } else this.closest = null;
    } else if (!tgt) this.closest = null;

    // orbit lines (5 Hz, or when map)
    this.lastOrbitUpdate -= dt;
    if (this.lastOrbitUpdate <= 0) {
      this.lastOrbitUpdate = this.view.camMode === 'map' ? 0.1 : 0.25;
      const showShip = ship.altitude > 0 && !ship.landed;
      this.view.updateOrbitLine('ship', ship.r, ship.v, showShip);
      if (this.target) this.view.updateOrbitLine('target', this.target.r, this.target.v, true);
      else this.view.updateOrbitLine('target', null, null, false);
    }

    // multiplayer
    if (this.net && this.net.active) this.netUpdate(dt);

    // camera shake from g-load / heating
    this.view.shake = Math.min(3, Math.max(0, ship.gForce - 1.5) * 0.6 + ship.heatFlux / 4e5 + (ship.thrustActive ? 0.15 : 0));

    const dirs = orbitalDirections(ship.r, ship.altitude < 70000 ? ship.airVel : ship.v);
    const targetDir = this.target ? this.targetPos().sub(ship.r).normalize() : null;
    const remotes = this.remoteRenderStates();
    if (this.skipRender) {
      ship.eclipse = this.view.computeEclipse ? this.view.computeEclipse(ship.r) : 1;
      return;
    }
    const { eclipse } = this.view.render({
      ship,
      simTime: this.simTime,
      dt,
      station: this.station,
      remotes,
      navball: { dirs, targetDir },
      mapFocus: null,
      fragment: this.extraTarget && this.extraTarget.kind === 'debris' ? this.extraTarget : null,
    });
    ship.eclipse = eclipse;
    this.hud.update(this, dt, remotes);
    this.updateAudio(dt);
  }

  updateAudio(dt) {
    const a = this.audio;
    if (!a) return;
    const ship = this.ship;
    const rc = ship.rotCmd;
    const tc = ship.transCmd;
    const rcs = Math.min(1, (Math.abs(rc.x) + Math.abs(rc.y) + Math.abs(rc.z)) * 0.4 + (Math.abs(tc.x) + Math.abs(tc.y) + Math.abs(tc.z)) * 0.6);
    a.update(dt, {
      throttle: ship.throttle,
      thrustActive: ship.thrustActive,
      rcs: ship.rcsEnabled && ship.rcsFuel > 0 ? rcs : 0,
      dynPressure: ship.dynPressure,
      heatFlux: ship.heatFlux,
      gForce: ship.gForce,
      altitude: ship.altitude,
      inAtmosphere: ship.altitude < 100000,
      chute: ship.chute,
      paused: this.state === 'paused' || this.state === 'briefing',
    });
    // music follows the situation
    if (this.state !== 'flying') return;
    this.moodTimer = (this.moodTimer || 0) - dt;
    if (this.moodTimer > 0) return;
    this.moodTimer = 1;
    let mood = 'cruise';
    const tgt = this.target;
    if (ship.heatFlux > 5e4 || (ship.stage === 1 && ship.altitude < 130000 && ship.chute === 'stowed')) mood = 'reentry';
    else if (this.docking && this.docking.range < 60 && !this.docked) mood = 'tension';
    else if (this.extraTarget && this.mission.tcaAbs && this.mission.tcaAbs - this.simTime < 120 && this.mission.tcaAbs - this.simTime > -5) mood = 'tension';
    else if (tgt && tgt.kind === 'station' && ship.r.distanceTo(tgt.r) < 2000 && !this.docked) mood = 'tension';
    if (mood !== this.mood) {
      this.mood = mood;
      a.setMood(mood);
    }
  }

  readControls(dt) {
    const ship = this.ship;
    const I = this.input;
    // KSP-style: W pitch down (nose down) / S pitch up; A/D yaw; Q/E roll
    const v1 = I.virtual || {};
    const v2 = I.agent || {};
    const vv = {};
    for (const k of ['pitch', 'yaw', 'roll', 'x', 'y', 'z']) vv[k] = (v1[k] || 0) + (v2[k] || 0);
    const c1 = (x) => Math.max(-1, Math.min(1, x));
    ship.rotInput.set(c1(I.axis('KeyW', 'KeyS') + (vv.pitch || 0)), c1(I.axis('KeyD', 'KeyA') + (vv.yaw || 0)), c1(I.axis('KeyE', 'KeyQ') + (vv.roll || 0)));
    ship.transInput.set(c1(I.axis('KeyJ', 'KeyL') + (vv.x || 0)), c1(I.axis('KeyK', 'KeyI') + (vv.y || 0)), c1(I.axis('KeyH', 'KeyN') + (vv.z || 0)));
    const dth = I.axis('KeyF', 'KeyR');
    if (dth !== 0) ship.throttle = Math.max(0, Math.min(1, ship.throttle + dth * dt * 0.7));
    if (ship.stage !== 0 && ship.throttle > 0) ship.throttle = 0;
    if ((ship.throttle > 0 || ship.transInput.lengthSq() > 0) && WARP_LEVELS[this.warpIndex] > 1) {
      this.warpIndex = 0;
    }
    if (this.docked && ship.transInput.lengthSq() + ship.throttle > 0) {
      this.toast('Docked — press SPACE to undock', 'info');
      ship.throttle = 0;
    }
  }

  /** Current navigation target: the station, or a mission-provided object (e.g. debris). */
  get target() {
    if (this.station) return { name: this.station.name || 'Station', kind: 'station', r: this.station.r, v: this.station.v };
    return this.extraTarget || null;
  }

  sasEnv() {
    return { targetPos: this.target ? this.targetPos() : null };
  }

  targetPos() {
    // target the docking port when close, otherwise the station centre
    const st = this.station;
    if (!st) return this.extraTarget ? this.extraTarget.r.clone() : null;
    const d = st.r.distanceTo(this.ship.r);
    return d < 1500 ? st.portWorld() : st.r.clone();
  }

  // ------------------------------------------------------------------ docking
  portVelocity(point) {
    const st = this.station;
    const omega = new Vector3().crossVectors(st.r, st.v).divideScalar(st.r.lengthSq());
    return st.v.clone().add(new Vector3().crossVectors(omega, point.clone().sub(st.r)));
  }

  computeDocking() {
    const st = this.station;
    const ship = this.ship;
    if (!st) return null;
    const dist = ship.r.distanceTo(st.r);
    if (dist > 2500) return null;
    const fwd = ship.forward(new Vector3());
    const shipPort = ship.r.clone().addScaledVector(fwd, ship.spec.noseOffset);
    const port = st.portWorld();
    const axis = st.portAxis();
    const d = shipPort.clone().sub(port);
    const axial = d.dot(axis);
    const latVec = d.clone().addScaledVector(axis, -axial);
    const relV = ship.v.clone().sub(this.portVelocity(port));
    const closing = -relV.dot(axis);
    const angle = Math.acos(Math.max(-1, Math.min(1, fwd.dot(axis.clone().negate())))) / DEG;
    const stUp = new Vector3(0, 1, 0).applyQuaternion(st.q);
    const shUp = ship.up(new Vector3());
    const p1 = stUp.addScaledVector(axis, -stUp.dot(axis)).normalize();
    const p2 = shUp.addScaledVector(axis, -shUp.dot(axis)).normalize();
    const roll = Math.acos(Math.max(-1, Math.min(1, p1.dot(p2)))) / DEG;
    // lateral components in station X / Y (for the docking display)
    const sx = new Vector3(1, 0, 0).applyQuaternion(st.q);
    const sy = new Vector3(0, 1, 0).applyQuaternion(st.q);
    // angular offsets of the ship axis (yaw/pitch) relative to the port axis
    const yawErr = Math.atan2(fwd.dot(sx), -fwd.dot(axis)) / DEG;
    const pitchErr = Math.atan2(fwd.dot(sy), -fwd.dot(axis)) / DEG;
    return {
      range: d.length(),
      axial,
      lateral: latVec.length(),
      latX: latVec.dot(sx),
      latY: latVec.dot(sy),
      closing,
      relSpeed: relV.length(),
      relV,
      angle,
      roll,
      yawErr,
      pitchErr,
    };
  }

  checkProximity() {
    const d = this.computeDocking();
    this.docking = d;
    if (!d || this.docked) return;
    const ship = this.ship;
    const st = this.station;
    if (d.axial < 0.12 && d.axial > -1.5 && d.lateral < 1.3) {
      if (d.lateral < 0.3 && d.angle < 5 && d.roll < 8 && d.closing < 0.35 && d.closing > -0.05) {
        this.dock(d);
        return;
      }
      // hard contact → bounce
      const port = st.portWorld();
      const pv = this.portVelocity(port);
      const axis = st.portAxis();
      if (d.closing > 0.7) {
        ship.destroy(`Docking mechanism damaged: contact at ${d.closing.toFixed(2)} m/s`);
        return;
      }
      ship.v.copy(pv).addScaledVector(axis, Math.max(0.05, d.closing * 0.5));
      ship.r.addScaledVector(axis, 0.15);
      this.penalize(150, 'Hard contact — misaligned');
      this.sfx('bump');
      return;
    }
    // structural collisions
    const fwd = ship.forward(new Vector3());
    const spheres = [[ship.r, 2.3]];
    if (ship.stage === 0) spheres.push([ship.r.clone().addScaledVector(fwd, -3.6), 2.45]);
    for (const [c, rad] of spheres) {
      if (st.collides(c, rad)) {
        const pv = this.portVelocity(c);
        const rel = ship.v.clone().sub(pv);
        const away = c.clone().sub(st.r).normalize();
        if (rel.length() > 0.8) {
          ship.destroy(`Collision with the station at ${rel.length().toFixed(1)} m/s`);
        } else {
          ship.v.copy(pv).addScaledVector(away, 0.2 + rel.length() * 0.3);
          ship.r.addScaledVector(away, 0.2);
          this.penalize(200, 'Bumped the station structure');
          this.sfx('bump');
        }
        return;
      }
    }
  }

  dock(contact) {
    const st = this.station;
    const ship = this.ship;
    // snap so the ports coincide and axes align
    const axis = st.portAxis();
    const stUp = new Vector3(0, 1, 0).applyQuaternion(st.q);
    const fwd = axis.clone().negate();
    const z = fwd.clone().negate();
    const x = new Vector3().crossVectors(stUp, z);
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, stUp, z));
    const relQ = st.q.clone().invert().multiply(q);
    const shipPos = st.portWorld().addScaledVector(fwd, -ship.spec.noseOffset);
    this.docked = { relPos: st.toLocal(shipPos), relQ };
    ship.w.set(0, 0, 0);
    ship.throttle = 0;
    this.applyDockedPose();
    this.toast('Soft capture — hooks closed', 'good');
    this.sfx('dock');
    this.stopWarp();
    if (this.mission.onDock) this.mission.onDock(this, contact);
  }

  applyDockedPose() {
    const st = this.station;
    const ship = this.ship;
    ship.r.copy(st.toWorld(this.docked.relPos));
    ship.v.copy(this.portVelocity(ship.r));
    ship.q.copy(st.q).multiply(this.docked.relQ);
    ship.w.set(0, 0, 0);
  }

  // ------------------------------------------------------------------ multiplayer
  netUpdate(dt) {
    this.netTimer -= dt;
    if (this.netTimer > 0) return;
    this.netTimer = 0.1;
    if (this.state === 'menu') return;
    const status = this.state === 'ended' ? (this.result?.success ? 'complete' : 'failed') : this.docked ? 'docked' : 'flying';
    this.net.sendState({
      t: 'state',
      m: this.missionId,
      st: this.simTime,
      s: this.ship.snapshot(),
      score: this.result ? this.result.total : this.score,
      status,
      warp: WARP_LEVELS[this.warpIndex],
    });
  }

  onRemoteState(id, msg, info) {
    let r = this.remotes.get(id);
    if (!r) {
      r = { id, r: new Vector3(), v: new Vector3(), q: new Quaternion() };
      this.remotes.set(id, r);
    }
    r.name = info?.name || 'Pilot';
    r.color = info?.color || '#ffaa44';
    r.mission = msg.m;
    r.simTime = msg.st;
    r.r.fromArray(msg.s.r);
    r.v.fromArray(msg.s.v);
    r.q.fromArray(msg.s.q);
    r.snap = msg.s;
    r.score = msg.score;
    r.status = msg.status;
    r.received = performance.now();
  }

  removeRemote(id) {
    this.remotes.delete(id);
    this.view.removeRemote(id);
  }

  remoteRenderStates() {
    const out = [];
    if (!this.net || !this.net.active || this.state === 'menu') return out;
    for (const r of this.remotes.values()) {
      if (r.mission !== this.missionId) continue;
      if (performance.now() - r.received > 5000) continue;
      let pos;
      let vel;
      const alt = r.r.length() - 6371000;
      const dtp = this.simTime - r.simTime;
      if (alt > ATMO_TOP && Math.abs(dtp) < 86400) {
        const p = propagateKepler(r.r, r.v, dtp);
        pos = p.r;
        vel = p.v;
      } else {
        const lim = Math.max(-1, Math.min(1, dtp));
        pos = r.r.clone().addScaledVector(r.v, lim);
        vel = r.v.clone();
      }
      const s = r.snap;
      out.push({
        id: r.id,
        name: r.name,
        color: r.color,
        r: pos,
        q: r.q,
        score: r.score,
        status: r.status,
        shipLike: {
          stage: s.st,
          throttle: s.th,
          thrustActive: s.th > 0,
          altitude: alt,
          chute: s.ch,
          chuteDeploy: 1,
          heatFlux: s.hf,
          rotCmd: new Vector3(),
          transCmd: new Vector3(),
          rcsEnabled: false,
          rcsFuel: 0,
          v: vel,
        },
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ menu background
  renderMenuBackground(dt) {
    this.menuOrbit += dt;
    const ship = this.ship;
    if (!this.menuInit) {
      this.menuInit = true;
      getMission('free').setup.call({}, this, 0);
      this.view.camMode = 'chase';
      this.view.orbitCam = { yaw: 2.2, pitch: 0.12, dist: 60 };
    }
    ship.step(dt, {});
    this.simTime += dt;
    if (this.station) this.station.update(this.simTime);
    ship.airVel = airVelocity(ship.r, ship.v);
    this.view.orbitCam.yaw += dt * 0.03;
    this.view.render({ ship, simTime: this.simTime, dt, station: this.station, remotes: [], navball: null });
  }
}

function confirmStage(game) {
  // guard against accidental service-module jettison outside the re-entry mission
  if (game.missionId === 'reentry') return true;
  const now = performance.now();
  if (game._stageConfirm && now - game._stageConfirm < 1500) return true;
  game._stageConfirm = now;
  game.toast('Press SPACE again to jettison the service module', 'warn');
  return false;
}
