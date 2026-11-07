// DOM heads-up display: flight data, navball frame, SAS buttons, gauges,
// target/docking displays, objectives, score popups, overlays and chat.
import { Vector3 } from 'three';
import { elementsFromState } from '../sim/orbit.js';
import { R_EARTH } from '../sim/constants.js';
import { SAS_MODES } from '../sim/spacecraft.js';
import { WARP_LEVELS } from '../game/game.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtDist(m) {
  const a = Math.abs(m);
  if (a >= 1e6) return `${(m / 1000).toFixed(0)} km`;
  if (a >= 1e4) return `${(m / 1000).toFixed(1)} km`;
  if (a >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(1)} m`;
}
function fmtTime(s) {
  if (!isFinite(s)) return '—';
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function fmtSpeed(v) {
  return Math.abs(v) >= 1000 ? `${v.toFixed(0)} m/s` : `${v.toFixed(1)} m/s`;
}

const SAS_LABELS = {
  stability: ['◎', 'Stability (1)'],
  prograde: ['⊕', 'Prograde (2)'],
  retrograde: ['⊗', 'Retrograde (3)'],
  normal: ['▲', 'Normal (4)'],
  antinormal: ['▼', 'Anti-normal (5)'],
  radialOut: ['⊙', 'Radial out (6)'],
  radialIn: ['⊚', 'Radial in (7)'],
  target: ['◉', 'Target (8)'],
  antiTarget: ['⦻', 'Anti-target (9)'],
};

export class Hud {
  constructor(root, view) {
    this.root = root;
    this.view = view;
    this.textTimer = 0;
    this.onSas = null;
    this.onAction = null;
    root.innerHTML = `
      <div id="hud" class="hidden">
        <div class="panel flight" id="flightPanel"></div>
        <div class="mission" id="missionPanel">
          <div class="mtitle" id="mTitle"></div>
          <ul class="objectives" id="mObjectives"></ul>
          <div class="hint" id="mHint"></div>
        </div>
        <div class="scorebox">
          <div class="score" id="score">0</div>
          <div class="scorelabel">POINTS</div>
          <div class="met" id="met"></div>
          <div class="warp" id="warp"></div>
          <div class="mpboard" id="mpBoard"></div>
        </div>
        <div class="toasts" id="toasts"></div>
        <div class="popups" id="popups"></div>
        <div class="labels" id="labels"></div>
        <div class="reticle hidden" id="reticle">
          <svg viewBox="-100 -100 200 200"><circle r="38" /><line x1="-90" y1="0" x2="-48" y2="0"/><line x1="48" y1="0" x2="90" y2="0"/><line x1="0" y1="-90" x2="0" y2="-48"/><line x1="0" y1="48" x2="0" y2="90"/><circle r="3" class="dot"/></svg>
        </div>
        <div class="dockpanel hidden" id="dockPanel">
          <div class="dtitle">DOCKING</div>
          <canvas id="dockCanvas" width="220" height="220"></canvas>
          <div class="drows" id="dockRows"></div>
        </div>
        <div class="bottom">
          <div class="panel systems" id="systems"></div>
          <div class="navcluster">
            <div class="speedbar" id="speedbar"></div>
            <div class="navrow">
              <div class="gauge vgauge" title="Throttle"><div class="fill" id="throttleFill"></div><span>THR</span></div>
              <div class="gauge vgauge g" title="G-load"><div class="fill" id="gFill"></div><span id="gLabel">G</span></div>
              <div class="navball" id="navball"><div class="shipmark"><svg viewBox="-50 -50 100 100"><path d="M-40 0 L-14 0 L-6 10 L0 0 L6 10 L14 0 L40 0" /><circle r="3"/></svg></div></div>
              <div class="sas" id="sasButtons"></div>
            </div>
            <div class="attitude" id="attitude"></div>
          </div>
          <div class="panel target" id="targetPanel"></div>
        </div>
        <div class="chat hidden" id="chat"><div class="log" id="chatLog"></div><input id="chatInput" maxlength="160" placeholder="Say something… (Enter)"/></div>
      </div>
      <div class="overlay hidden" id="overlay"></div>
      <div class="help hidden" id="help"></div>
    `;
    this.hudEl = $('#hud', root);
    this.el = {
      flight: $('#flightPanel', root),
      title: $('#mTitle', root),
      objectives: $('#mObjectives', root),
      hint: $('#mHint', root),
      score: $('#score', root),
      met: $('#met', root),
      warp: $('#warp', root),
      mp: $('#mpBoard', root),
      toasts: $('#toasts', root),
      popups: $('#popups', root),
      labels: $('#labels', root),
      reticle: $('#reticle', root),
      dock: $('#dockPanel', root),
      dockCanvas: $('#dockCanvas', root),
      dockRows: $('#dockRows', root),
      systems: $('#systems', root),
      speedbar: $('#speedbar', root),
      throttle: $('#throttleFill', root),
      gFill: $('#gFill', root),
      gLabel: $('#gLabel', root),
      navball: $('#navball', root),
      sas: $('#sasButtons', root),
      attitude: $('#attitude', root),
      target: $('#targetPanel', root),
      overlay: $('#overlay', root),
      help: $('#help', root),
      chat: $('#chat', root),
      chatLog: $('#chatLog', root),
      chatInput: $('#chatInput', root),
    };
    this.sasButtons = {};
    for (const mode of SAS_MODES) {
      const b = document.createElement('button');
      b.className = 'sasbtn';
      b.innerHTML = SAS_LABELS[mode][0];
      b.title = SAS_LABELS[mode][1];
      b.setAttribute('aria-label', 'SAS ' + SAS_LABELS[mode][1]);
      b.dataset.testid = 'sas-' + mode;
      b.addEventListener('click', () => this.onSas && this.onSas(mode));
      this.el.sas.appendChild(b);
      this.sasButtons[mode] = b;
    }
    this.labelPool = new Map();
    this.objectivesKey = '';
    this.el.help.innerHTML = HELP_HTML;
    this.el.help.addEventListener('click', () => this.toggleHelp());
    this.el.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.el.chatInput.value.trim();
        if (text && this.onChat) this.onChat(text);
        this.el.chatInput.value = '';
        this.el.chatInput.blur();
      } else if (e.key === 'Escape') this.el.chatInput.blur();
    });
  }

  show(on) {
    this.hudEl.classList.toggle('hidden', !on);
  }

  // ------------------------------------------------------------------ overlays
  overlay(html) {
    this.el.overlay.innerHTML = html;
    this.el.overlay.classList.remove('hidden');
    return this.el.overlay;
  }
  hideOverlays() {
    this.el.overlay.classList.add('hidden');
  }

  showBriefing(mission, onStart) {
    this.show(true);
    const o = this.overlay(`
      <div class="card briefing">
        <div class="tag">${esc(mission.tag)}</div>
        <h1>${esc(mission.title)}</h1>
        <p class="summary">${esc(mission.summary)}</p>
        <ol>${mission.briefing.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
        ${mission.stars[0] ? `<div class="starsreq">★ ${mission.stars[0]} &nbsp; ★★ ${mission.stars[1]} &nbsp; ★★★ ${mission.stars[2]}</div>` : ''}
        <div class="buttons"><button class="primary" id="btnStart">Begin mission ▸</button><button id="btnHelp">Controls (F1)</button><button id="btnAbort">Back to menu</button></div>
      </div>`);
    $('#btnStart', o).onclick = onStart;
    $('#btnHelp', o).onclick = () => this.toggleHelp();
    $('#btnAbort', o).onclick = () => this.onAction && this.onAction('menu');
    setTimeout(() => $('#btnStart', o)?.focus(), 50);
  }

  showPause() {
    const o = this.overlay(`
      <div class="card pause">
        <h1>Paused</h1>
        <div class="buttons col">
          <button class="primary" id="pResume">Resume</button>
          <button id="pRestart">Restart mission</button>
          <button id="pHelp">Controls</button>
          <button id="pMenu">Abort to menu</button>
        </div>
      </div>`);
    $('#pResume', o).onclick = () => this.onAction && this.onAction('resume');
    $('#pRestart', o).onclick = () => this.onAction && this.onAction('restart');
    $('#pHelp', o).onclick = () => this.toggleHelp();
    $('#pMenu', o).onclick = () => this.onAction && this.onAction('menu');
  }

  showResult(mission, res) {
    const stars = [0, 1, 2].map((i) => `<span class="${i < res.stars ? 'on' : ''}">★</span>`).join('');
    const rows = [...res.log, ...res.bonuses.map((b) => ({ ...b, bonus: true }))]
      .map((r) => `<tr class="${r.points < 0 ? 'neg' : ''}"><td>${r.bonus ? 'Bonus · ' : ''}${esc(r.label)}</td><td>${r.points >= 0 ? '+' : ''}${r.points}</td></tr>`)
      .join('');
    const next = mission.stars.find((s) => s > res.total);
    const patches = (res.achievements || []).map((a) => `<span class="chip">${a.icon} ${esc(a.title)}</span>`).join('');
    const o = this.overlay(`
      <div class="card result ${res.success ? 'ok' : 'fail'}" role="dialog" aria-label="Mission result">
        <div class="tag">${esc(mission.title)}${res.daily ? ' · DAILY CHALLENGE' : ''}</div>
        <h1>${res.success ? 'Mission complete' : 'Mission failed'}</h1>
        <p class="summary">${esc(res.reason || '')}</p>
        ${mission.free ? '' : `<div class="stars">${stars}</div><div class="total" data-testid="result-total">${res.total} <small>points</small>${res.isBest ? '<span class="best">NEW BEST</span>' : ''}</div>`}
        ${res.xpGained ? `<div class="xpline">+${res.xpGained} XP${res.levelUp ? ` · <b>LEVEL UP → ${res.levelUp}</b>` : ''}${next && res.success ? ` · ${next - res.total} pts to the next ★` : ''}</div>` : ''}
        ${patches ? `<div class="chips">${patches}</div>` : ''}
        <table class="breakdown">${rows}</table>
        ${res.success ? '' : '<p class="note">Failed missions keep 25% of points earned. Try again — every attempt earns XP.</p>'}
        <div class="buttons"><button class="primary" id="rRetry" data-testid="retry">Retry</button><button id="rNext">Next mission ▸</button><button id="rShare">Share</button><button id="rMenu">Menu</button><button id="rFly">Keep flying</button></div>
      </div>`);
    $('#rRetry', o).onclick = () => this.onAction && this.onAction('restart');
    $('#rNext', o).onclick = () => this.onAction && this.onAction('next');
    $('#rMenu', o).onclick = () => this.onAction && this.onAction('menu');
    $('#rFly', o).onclick = () => this.hideOverlays();
    $('#rShare', o).onclick = async () => {
      const text = `🚀 ${mission.title}: ${res.total} pts ${'★'.repeat(res.stars)} in Orbital Academy — can you beat it?`;
      const url = location.origin + location.pathname;
      try {
        if (navigator.share) await navigator.share({ title: 'Orbital Academy', text, url });
        else {
          await navigator.clipboard.writeText(`${text} ${url}`);
          this.toast('Copied to clipboard', 'good');
        }
      } catch {
        /* cancelled */
      }
    };
  }

  toggleHelp() {
    this.el.help.classList.toggle('hidden');
  }

  // ------------------------------------------------------------------ messages
  toast(msg, type = 'info') {
    const d = document.createElement('div');
    d.className = `toast ${type}`;
    d.textContent = msg;
    this.el.toasts.appendChild(d);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
    setTimeout(() => d.classList.add('fade'), 3500);
    setTimeout(() => d.remove(), 4200);
  }

  popup(points, label, type, combo = 0) {
    const d = document.createElement('div');
    d.className = `popup ${type}`;
    d.innerHTML = `<b>${esc(points)}</b> ${esc(label)}${combo >= 3 ? `<i class="combo">×${combo} streak</i>` : ''}`;
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }

  achievement(a) {
    const d = document.createElement('div');
    d.className = 'achv';
    d.innerHTML = `<div class="ic">${a.icon}</div><div><small>PATCH UNLOCKED · +150 XP</small><b>${esc(a.title)}</b><span>${esc(a.desc)}</span></div>`;
    document.body.appendChild(d);
    setTimeout(() => d.classList.add('out'), 3600);
    setTimeout(() => d.remove(), 4300);
  }

  openChat() {
    this.el.chat.classList.remove('hidden');
    this.el.chatInput.focus();
  }

  chatMessage(name, text, color = '#9fd0ff') {
    this.el.chat.classList.remove('hidden');
    const d = document.createElement('div');
    d.innerHTML = `<b style="color:${esc(color)}">${esc(name)}</b> ${esc(text)}`;
    this.el.chatLog.appendChild(d);
    while (this.el.chatLog.children.length > 8) this.el.chatLog.firstChild.remove();
  }

  // ------------------------------------------------------------------ per-frame
  update(game, dt, remotes) {
    const ship = game.ship;
    const view = this.view;
    // navball rectangle for the renderer
    const nb = this.el.navball.getBoundingClientRect();
    view.navballRect = nb.width > 0 && game.state !== 'menu' ? { x: nb.left, y: nb.top, size: nb.width } : null;

    const cockpit = view.camMode === 'cockpit';
    this.el.reticle.classList.toggle('hidden', !cockpit);

    this.updateLabels(game, remotes);

    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 1 / 12;

    // ---- flight data ----
    const alt = ship.altitude;
    const el = elementsFromState(ship.r, ship.v);
    const vOrb = ship.v.length();
    const vSrf = ship.airVel ? ship.airVel.length() : vOrb;
    const rows = [
      ['ALT', fmtDist(alt)],
      ['ORB VEL', fmtSpeed(vOrb)],
      ['VERT', `${ship.verticalSpeed >= 0 ? '+' : ''}${ship.verticalSpeed.toFixed(1)} m/s`],
    ];
    if (alt < 80000) rows.push(['SRF VEL', fmtSpeed(vSrf)], ['MACH', (vSrf / 300).toFixed(1)], ['Q', `${(ship.dynPressure / 1000).toFixed(1)} kPa`]);
    if (el.e < 1) {
      rows.push(['APOAPSIS', `${fmtDist(el.ra - R_EARTH)} <i>${fmtTime(el.timeToAp)}</i>`]);
    }
    rows.push(['PERIAPSIS', `${fmtDist(el.rp - R_EARTH)} <i>${fmtTime(el.timeToPe)}</i>`]);
    rows.push(['INC', `${((el.i * 180) / Math.PI).toFixed(2)}°`]);
    if (isFinite(el.period)) rows.push(['PERIOD', fmtTime(el.period)]);
    rows.push(['ECC', el.e.toFixed(4)]);
    this.el.flight.innerHTML = `<div class="ptitle">FLIGHT</div>${rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')}`;

    // ---- mission ----
    this.el.title.textContent = game.mission ? game.mission.title : '';
    const key = game.objectives.map((o) => o.text + o.state).join('|');
    if (key !== this.objectivesKey) {
      this.objectivesKey = key;
      this.el.objectives.innerHTML = game.objectives.map((o) => `<li class="${o.state}">${esc(o.text)}</li>`).join('');
    }
    this.el.hint.textContent = game.hint || '';
    this.el.score.textContent = game.mission?.free ? '—' : String(Math.round(game.result ? game.result.total : game.score));
    this.el.met.textContent = `MET ${fmtTime(game.missionTime)}`;
    const warp = WARP_LEVELS[game.warpIndex];
    this.el.warp.innerHTML = `<span class="${warp > 1 ? 'on' : ''}">⏩ ${warp}×</span> ${warp > 10 ? '<em>on rails</em>' : ''}`;

    // multiplayer scoreboard
    if (game.multiplayer && game.net?.active) {
      const list = [{ name: game.net.name + ' (you)', score: Math.round(game.result ? game.result.total : game.score), status: game.state, color: game.net.color }];
      for (const r of game.remotes.values()) list.push({ name: r.name, score: r.score ?? 0, status: r.status || '…', color: r.color });
      list.sort((a, b) => b.score - a.score);
      this.el.mp.innerHTML = `<div class="ptitle">PILOTS</div>` + list.map((p, i) => `<div class="row"><span><i style="background:${esc(p.color)}"></i>${i + 1}. ${esc(p.name)}</span><b>${p.score}</b><em>${esc(p.status)}</em></div>`).join('');
    } else this.el.mp.innerHTML = '';

    // ---- navball cluster ----
    const speedMode = alt < 70000 ? 'SURFACE' : game.station && game.docking && game.docking.range < 2000 ? 'TARGET' : 'ORBIT';
    const speedVal = speedMode === 'SURFACE' ? vSrf : speedMode === 'TARGET' ? game.docking.relSpeed : vOrb;
    this.el.speedbar.innerHTML = `<span>${speedMode}</span><b>${speedMode === 'TARGET' ? speedVal.toFixed(2) + ' m/s' : fmtSpeed(speedVal)}</b>`;
    this.el.throttle.style.height = `${ship.throttle * 100}%`;
    const g = Math.min(10, ship.gForce);
    this.el.gFill.style.height = `${(g / 10) * 100}%`;
    this.el.gFill.classList.toggle('warn', ship.gForce > 6);
    this.el.gLabel.textContent = `${ship.gForce.toFixed(1)}G`;
    for (const [mode, b] of Object.entries(this.sasButtons)) {
      b.classList.toggle('active', ship.sasEnabled && ship.sasMode === mode);
      b.disabled = ship.sasLocked || ((mode === 'target' || mode === 'antiTarget') && !game.target);
    }
    // heading / pitch / roll relative to local horizon
    const up = ship.r.clone().normalize();
    const east = new Vector3(0, 1, 0).cross(up).normalize();
    const north = new Vector3().crossVectors(up, east);
    const f = ship.forward(new Vector3());
    const pitch = Math.asin(Math.max(-1, Math.min(1, f.dot(up)))) * (180 / Math.PI);
    let hdg = Math.atan2(f.dot(east), f.dot(north)) * (180 / Math.PI);
    if (hdg < 0) hdg += 360;
    const bodyUp = ship.up(new Vector3());
    const right = new Vector3(1, 0, 0).applyQuaternion(ship.q);
    const roll = Math.atan2(-right.dot(up), bodyUp.dot(up)) * (180 / Math.PI);
    this.el.attitude.innerHTML = `HDG <b>${hdg.toFixed(0)}°</b> PIT <b>${pitch.toFixed(0)}°</b> ROLL <b>${roll.toFixed(0)}°</b> · RATE <b>${((ship.w.length() * 180) / Math.PI).toFixed(2)}°/s</b>`;

    // ---- systems ----
    const pct = (x) => `${Math.max(0, x * 100).toFixed(0)}%`;
    const bar = (frac, cls = '') => `<div class="bar ${cls}"><div style="width:${Math.max(0, Math.min(1, frac)) * 100}%"></div></div>`;
    const fuelFrac = ship.stage === 0 ? ship.fuel / ship.spec.smFuel : 0;
    const flag = (on, label) => `<span class="flag ${on ? 'on' : ''}">${label}</span>`;
    this.el.systems.innerHTML = `
      <div class="ptitle">SYSTEMS · ${esc(ship.spec.name)}</div>
      <div class="flags">${flag(ship.sasEnabled, 'SAS')}${flag(ship.rcsEnabled, 'RCS')}${flag(ship.precision, 'PREC')}${flag(ship.autoRoll, 'ROLL↑')}${flag(game.docked, 'DOCKED')}</div>
      <div class="row"><span>MAIN PROP</span><b>${ship.stage === 0 ? ship.fuel.toFixed(0) + ' kg' : 'jettisoned'}</b></div>${bar(fuelFrac)}
      <div class="row"><span>Δv REMAINING</span><b>${ship.deltaV.toFixed(0)} m/s</b></div>
      <div class="row"><span>RCS PROP</span><b>${ship.rcsFuel.toFixed(1)} kg</b></div>${bar(ship.rcsFuel / ship.spec.rcsFuel, 'rcs')}
      <div class="row"><span>HEAT SHIELD</span><b>${pct(ship.shield)}</b></div>${bar(ship.shield, 'shield')}
      ${ship.heatFlux > 1e4 ? `<div class="row hot"><span>HEAT FLUX</span><b>${(ship.heatFlux / 1e4).toFixed(0)} W/cm²</b></div>${bar(ship.heatFlux / 8e5, 'heat')}` : ''}
      ${ship.hullDamage > 0.01 ? `<div class="row hot"><span>HULL DAMAGE</span><b>${pct(ship.hullDamage)}</b></div>` : ''}
      <div class="row"><span>STAGE</span><b>${ship.stage === 0 ? 'CM + SM' : 'Crew module'} · chutes ${ship.chute}</b></div>
      <div class="row"><span>LIGHT</span><b>${ship.eclipse > 0.5 ? 'Daylight' : 'Eclipse'}</b></div>`;

    // ---- target ----
    const tgt = game.target;
    if (tgt) {
      const d = game.docking;
      const dist = ship.r.distanceTo(tgt.r);
      const rel = ship.v.distanceTo(tgt.v);
      const ca = game.closest;
      this.el.target.classList.remove('invisible');
      this.el.target.innerHTML = `
        <div class="ptitle">TARGET · ${esc(tgt.name)}</div>
        <div class="row"><span>RANGE</span><b>${fmtDist(dist)}</b></div>
        <div class="row"><span>REL SPEED</span><b>${rel.toFixed(2)} m/s</b></div>
        ${d ? `<div class="row"><span>CLOSING</span><b>${d.closing.toFixed(2)} m/s</b></div>` : ''}
        ${ca ? `<div class="row"><span>CLOSEST APPR.</span><b>${fmtDist(ca.distance)} <i>in ${fmtTime(ca.time)}</i></b></div><div class="row"><span>REL @ CA</span><b>${ca.relSpeed.toFixed(1)} m/s</b></div>` : ''}`;
    } else this.el.target.classList.add('invisible');

    // ---- docking display ----
    const d = game.docking;
    const showDock = d && d.range < 250 && !game.docked;
    this.el.dock.classList.toggle('hidden', !showDock);
    if (showDock) this.drawDocking(d);
  }

  drawDocking(d) {
    const c = this.el.dockCanvas;
    const g = c.getContext('2d');
    const W = c.width;
    g.clearRect(0, 0, W, W);
    g.save();
    g.translate(W / 2, W / 2);
    g.strokeStyle = 'rgba(140,220,255,0.35)';
    g.lineWidth = 1;
    for (const r of [25, 50, 75, 100]) {
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-105, 0);
    g.lineTo(105, 0);
    g.moveTo(0, -105);
    g.lineTo(0, 105);
    g.stroke();
    // capture box (0.3 m)
    const scaleLat = d.range < 20 ? 100 / 1.0 : 100 / 10; // px per metre
    const box = 0.3 * scaleLat;
    g.strokeStyle = '#3dff9a';
    g.strokeRect(-box, -box, box * 2, box * 2);
    // lateral offset (station X right, Y up)
    const lx = Math.max(-105, Math.min(105, d.latX * scaleLat));
    const ly = Math.max(-105, Math.min(105, -d.latY * scaleLat));
    g.fillStyle = d.lateral < 0.3 ? '#3dff9a' : '#ffcc44';
    g.beginPath();
    g.arc(lx, ly, 6, 0, Math.PI * 2);
    g.fill();
    // angular error (yaw/pitch) as a cross, 10 px per degree
    const ax = Math.max(-105, Math.min(105, d.yawErr * 10));
    const ay = Math.max(-105, Math.min(105, -d.pitchErr * 10));
    g.strokeStyle = d.angle < 2 ? '#3dff9a' : '#ff6a6a';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(ax - 10, ay);
    g.lineTo(ax + 10, ay);
    g.moveTo(ax, ay - 10);
    g.lineTo(ax, ay + 10);
    g.stroke();
    g.restore();
    g.fillStyle = 'rgba(200,230,255,0.7)';
    g.font = '10px monospace';
    g.fillText(`● offset (${d.range < 20 ? '1' : '10'} m/ring)  ✚ angle (10°/ring)`, 6, W - 6);
    const ok = (v) => (v ? 'ok' : 'bad');
    const closingOk = d.range < 5 ? d.closing <= 0.3 && d.closing >= 0.03 : d.closing < Math.max(0.3, d.range * 0.02);
    this.el.dockRows.innerHTML = `
      <div class="row"><span>RANGE</span><b>${d.range.toFixed(2)} m</b></div>
      <div class="row ${ok(closingOk)}"><span>CLOSING</span><b>${d.closing.toFixed(3)} m/s</b></div>
      <div class="row ${ok(d.lateral < 0.3)}"><span>LATERAL</span><b>${d.lateral.toFixed(2)} m</b></div>
      <div class="row ${ok(d.angle < 5)}"><span>ANGLE</span><b>${d.angle.toFixed(2)}°</b></div>
      <div class="row ${ok(d.roll < 8)}"><span>ROLL</span><b>${d.roll.toFixed(1)}°</b></div>`;
  }

  updateLabels(game, remotes) {
    const view = this.view;
    const used = new Set();
    const place = (key, world, html, cls) => {
      if (!view.inFront(world)) return;
      const p = view.project(world);
      if (!p) return;
      let el = this.labelPool.get(key);
      if (!el) {
        el = document.createElement('div');
        this.el.labels.appendChild(el);
        this.labelPool.set(key, el);
      }
      el.className = `label ${cls}`;
      if (el._html !== html) {
        el.innerHTML = html;
        el._html = html;
      }
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      used.add(key);
    };
    const ship = game.ship;
    const isMap = view.camMode === 'map';
    if (game.state !== 'menu') {
      const tgt = game.target;
      if (tgt) {
        const dist = ship.r.distanceTo(tgt.r);
        if (dist > 400 || isMap) place('station', tgt.r, `<span class="br">${esc(tgt.name.toUpperCase())}</span><em>${fmtDist(dist)}</em>`, 'target');
      }
      for (const r of remotes) {
        const dist = ship.r.distanceTo(r.r);
        place(`p:${r.id}`, r.r, `<span class="br" style="border-color:${esc(r.color)}">${esc(r.name)}</span><em>${fmtDist(dist)}</em>`, 'player');
      }
      if (isMap) {
        place('me', ship.r, `<span class="br">YOU</span>`, 'me');
        const el = elementsFromState(ship.r, ship.v);
        if (el.e > 1e-4) {
          const ehat = el.evec.clone().normalize();
          place('pe', ehat.clone().multiplyScalar(el.rp), `<span class="br">Pe</span><em>${fmtDist(el.rp - R_EARTH)}</em>`, 'apsis');
          if (el.e < 1) place('ap', ehat.clone().multiplyScalar(-el.ra), `<span class="br">Ap</span><em>${fmtDist(el.ra - R_EARTH)}</em>`, 'apsis');
        }
      }
    }
    for (const [k, el] of this.labelPool) {
      el.style.display = used.has(k) ? '' : 'none';
    }
  }
}

const HELP_HTML = `
<div class="card helpcard">
  <h1>Flight controls</h1>
  <div class="cols">
    <table>
      <tr><th colspan="2">Attitude (RCS)</th></tr>
      <tr><td>W / S</td><td>Pitch down / up</td></tr>
      <tr><td>A / D</td><td>Yaw left / right</td></tr>
      <tr><td>Q / E</td><td>Roll left / right</td></tr>
      <tr><td>T</td><td>SAS on / off</td></tr>
      <tr><td>1 – 9</td><td>SAS: stability, prograde, retrograde, normal, anti-normal, radial out, radial in, target, anti-target</td></tr>
      <tr><td>U</td><td>SAS auto-roll heads-up (lift vector up)</td></tr>
      <tr><td>G</td><td>RCS on / off</td></tr>
      <tr><td>\`</td><td>Precision (fine) controls</td></tr>
    </table>
    <table>
      <tr><th colspan="2">Translation &amp; propulsion</th></tr>
      <tr><td>H / N</td><td>Translate forward / back</td></tr>
      <tr><td>I / K</td><td>Translate up / down</td></tr>
      <tr><td>J / L</td><td>Translate left / right</td></tr>
      <tr><td>R / F</td><td>Throttle up / down</td></tr>
      <tr><td>Z / X</td><td>Full throttle / cut engine</td></tr>
      <tr><td>Space</td><td>Stage: jettison SM → drogues → mains (or undock)</td></tr>
    </table>
    <table>
      <tr><th colspan="2">View &amp; time</th></tr>
      <tr><td>Mouse drag</td><td>Orbit camera</td></tr>
      <tr><td>Wheel</td><td>Zoom</td></tr>
      <tr><td>V</td><td>Camera: chase / locked / docking cam</td></tr>
      <tr><td>M</td><td>Map view</td></tr>
      <tr><td>. / ,</td><td>Time warp up / down (0 = reset)</td></tr>
      <tr><td>P / Esc</td><td>Pause</td></tr>
      <tr><td>Enter</td><td>Chat (multiplayer)</td></tr>
      <tr><td>F1 or /</td><td>This help</td></tr>
    </table>
  </div>
  <p class="note">Navball markers: <b style="color:#ffe14d">⊕ prograde / ⊗ retrograde</b>, <b style="color:#d36bff">▲ normal / ▼ anti-normal</b>, <b style="color:#4de1ff">radial out / in</b>, <b style="color:#ff4fa3">◉ target</b>. Click anywhere to close.</p>
</div>`;
