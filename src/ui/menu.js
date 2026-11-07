// Main menu: pilot profile, training modules, daily challenge, multiplayer
// (Nostr rooms / direct link), global leaderboard, achievements, settings.
import { MISSIONS, rankFor } from '../game/missions.js';
import { ACHIEVEMENTS } from '../game/achievements.js';
import { dailyChallenge } from '../game/daily.js';
import { levelForXp, xpForLevel } from '../game/progress.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TRAINING = MISSIONS.filter((m) => !m.free);

export class Menu {
  constructor(root, { progress, net, onStart, onSettings, onUi }) {
    this.root = root;
    this.progress = progress;
    this.net = net;
    this.onStart = onStart;
    this.onSettings = onSettings;
    this.onUi = onUi || (() => {});
    this.tab = 'training';
    this.lobbyMission = 'docking';
    this.lbBoard = 'docking';
    root.innerHTML = `
      <div class="menu" id="menuRoot">
        <header>
          <div class="logo"><span class="ring"></span><div><h1>ORBITAL ACADEMY</h1><p>Astronaut training simulator</p></div></div>
          <div class="pilot" id="pilotCard"></div>
        </header>
        <nav role="tablist" aria-label="Menu sections">
          ${[
            ['training', 'Training'],
            ['daily', 'Daily ⚡'],
            ['multiplayer', 'Multiplayer'],
            ['leaderboard', 'Leaderboard'],
            ['pilot', 'Patches'],
            ['settings', 'Settings'],
            ['controls', 'How to fly'],
          ]
            .map(([id, label]) => `<button role="tab" data-tab="${id}" data-testid="tab-${id}" class="${id === 'training' ? 'active' : ''}">${label}</button>`)
            .join('')}
        </nav>
        <section id="tabBody"></section>
        <footer>Real two-body orbital mechanics · NASA Blue Marble imagery · US-76 atmosphere · Sutton–Graves heating · serverless WebRTC over Nostr</footer>
      </div>`;
    this.el = root.firstElementChild;
    this.body = $('#tabBody', root);
    root.querySelectorAll('nav button').forEach((b) =>
      b.addEventListener('click', () => {
        this.onUi('click');
        this.setTab(b.dataset.tab);
      }),
    );
    net.on('roster', () => this.tab === 'multiplayer' && this.renderLobby());
    net.on('status', (s) => this.setStatus(s));
    net.on('lobby', (msg) => {
      this.lobbyMission = msg.mission;
      if (this.tab === 'multiplayer') this.renderLobby();
    });
    this.render();
  }

  setTab(tab) {
    this.tab = tab;
    this.root.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    this.render();
  }

  show(on) {
    this.el.classList.toggle('hidden', !on);
    if (on) this.render();
  }

  renderPilot() {
    const p = this.progress;
    const rank = rankFor(p.total);
    const lvl = levelForXp(p.xp);
    const a = xpForLevel(lvl);
    const b = xpForLevel(lvl + 1);
    const frac = (p.xp - a) / (b - a);
    $('#pilotCard', this.root).innerHTML = `
      <label>Callsign <input id="pilotName" maxlength="20" value="${esc(p.name)}" aria-label="Pilot callsign"/></label>
      <div class="rankrow"><span class="lvl">LV ${lvl}</span><span class="rank">${esc(rank.name)}</span>${p.streak.days > 1 ? `<span class="streak" title="Days in a row">🔥 ${p.streak.days}</span>` : ''}</div>
      <div class="xpbar" title="${p.xp} XP"><div style="width:${(frac * 100).toFixed(1)}%"></div></div>
      <div class="totals"><b>${p.total}</b> pts · <b>${p.totalStars}</b>/${TRAINING.length * 3} ★ · <b>${Object.keys(p.achievements).length}</b>/${ACHIEVEMENTS.length} patches</div>`;
    $('#pilotName', this.root).addEventListener('change', (e) => {
      p.name = e.target.value.trim().slice(0, 20) || p.name;
      p.save();
    });
  }

  render() {
    this.renderPilot();
    const t = this.tab;
    if (t === 'training') this.renderTraining();
    else if (t === 'daily') this.renderDaily();
    else if (t === 'multiplayer') this.renderMultiplayer();
    else if (t === 'leaderboard') this.renderLeaderboard();
    else if (t === 'pilot') this.renderPatches();
    else if (t === 'settings') this.renderSettings();
    else this.renderControls();
  }

  // ------------------------------------------------------------------ training
  renderTraining() {
    let n = 0;
    const cards = MISSIONS.map((m) => {
      const best = this.progress.best(m.id);
      const stars = [0, 1, 2].map((k) => `<span class="${best && k < best.stars ? 'on' : ''}">★</span>`).join('');
      const diff = m.difficulty ? '●'.repeat(m.difficulty) + '○'.repeat(5 - m.difficulty) : 'sandbox';
      return `
        <article class="mcard" data-id="${m.id}">
          <div class="num">${m.free ? '∞' : String(++n).padStart(2, '0')}</div>
          <div class="tag">${esc(m.tag)}</div>
          <h3>${esc(m.title)}</h3>
          <p>${esc(m.summary)}</p>
          <div class="meta"><span class="diff" aria-label="difficulty ${m.difficulty}">${diff}</span>${m.free ? '' : `<span class="stars">${stars}</span><span class="best">${best ? best.score + ' pts' : '—'}</span>`}</div>
          <button class="primary fly" data-testid="fly-${m.id}" aria-label="Fly ${esc(m.title)}">Fly ▸</button>
        </article>`;
    }).join('');
    this.body.innerHTML = `<div class="grid">${cards}</div>`;
    this.body.querySelectorAll('.mcard').forEach((c) => {
      c.querySelector('.fly').addEventListener('click', () => this.onStart(c.dataset.id, { multiplayer: false }));
    });
  }

  // ------------------------------------------------------------------ daily
  renderDaily() {
    const d = dailyChallenge();
    const mine = this.progress.daily[d.key];
    const m = MISSIONS.find((x) => x.id === d.mission);
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    const hrs = Math.floor((next - Date.now()) / 3600000);
    const mins = Math.floor(((next - Date.now()) % 3600000) / 60000);
    this.body.innerHTML = `
      <div class="daily">
        <article class="mcard dailycard">
          <div class="tag">Daily challenge · ${esc(d.key)} · new one in ${hrs}h ${mins}m</div>
          <h3>${esc(d.title)}</h3>
          <p>${esc(m.title)} — ${esc(d.description)}</p>
          <p class="small">Same scenario for every pilot on Earth today. +250 bonus XP on completion.${this.progress.streak.days ? ` Current streak: 🔥 ${this.progress.streak.days} day(s).` : ''}</p>
          <div class="meta"><span class="best">${mine?.best ? 'Your best today: ' + mine.best + ' pts' : 'Not flown yet today'}</span></div>
          <button class="primary fly" id="dailyFly" data-testid="fly-daily">Fly today's challenge ▸</button>
        </article>
        <div class="mpcol">
          <h3>Today's global ranking</h3>
          <div id="dailyBoard" class="board"><p class="small">Loading from Nostr relays…</p></div>
        </div>
      </div>`;
    $('#dailyFly', this.body).onclick = () => this.onStart(d.mission, { multiplayer: false, daily: d, modifiers: d.mods });
    this.loadBoard(d.board, $('#dailyBoard', this.body));
  }

  async loadBoard(board, el) {
    try {
      const rows = await this.net.leaderboard(board, 25);
      if (!el.isConnected) return;
      if (!rows.length) {
        el.innerHTML = '<p class="small">No scores yet — be the first!</p>';
        return;
      }
      el.innerHTML = `<ol>${rows
        .map((r, i) => `<li class="${r.me ? 'me' : ''}"><span class="pos">${i + 1}</span><span class="nm">${esc(r.name)}${r.me ? ' (you)' : ''}</span><span class="st">${'★'.repeat(r.stars)}</span><b>${r.score}</b></li>`)
        .join('')}</ol>`;
    } catch (e) {
      if (el.isConnected) el.innerHTML = `<p class="small">Leaderboard unavailable (${esc(e.message)}).</p>`;
    }
  }

  // ------------------------------------------------------------------ leaderboard
  renderLeaderboard() {
    const opts = TRAINING.map((m) => `<option value="${m.id}" ${m.id === this.lbBoard ? 'selected' : ''}>${esc(m.title)}</option>`).join('');
    this.body.innerHTML = `
      <div class="lb">
        <div class="mpcol">
          <h3>Global leaderboard</h3>
          <p class="small">Best scores are published to public Nostr relays, signed with a key kept in this browser. No accounts and no server. ${this.progress.settings.shareScores ? '' : '<b>Score sharing is off in Settings.</b>'}</p>
          <label>Module<select id="lbSel" aria-label="Leaderboard module">${opts}</select></label>
          <div id="lbBoard" class="board"><p class="small">Loading…</p></div>
        </div>
      </div>`;
    $('#lbSel', this.body).onchange = (e) => {
      this.lbBoard = e.target.value;
      this.loadBoard(this.lbBoard, $('#lbBoard', this.body));
    };
    this.loadBoard(this.lbBoard, $('#lbBoard', this.body));
  }

  // ------------------------------------------------------------------ patches
  renderPatches() {
    const p = this.progress;
    const items = ACHIEVEMENTS.map((a) => {
      const got = p.achievements[a.id];
      return `<div class="patch ${got ? 'got' : ''}" title="${esc(a.desc)}"><div class="ic">${got ? a.icon : '🔒'}</div><b>${esc(a.title)}</b><span>${esc(a.desc)}</span></div>`;
    }).join('');
    this.body.innerHTML = `
      <div class="stats"><div><b>${p.flights}</b><span>flights</span></div><div><b>${p.xp}</b><span>XP</span></div><div><b>${p.streak.best || 0}</b><span>best streak</span></div><div><b>${Object.keys(p.achievements).length}/${ACHIEVEMENTS.length}</b><span>patches</span></div></div>
      <div class="patches">${items}</div>`;
  }

  // ------------------------------------------------------------------ multiplayer
  renderMultiplayer() {
    const net = this.net;
    if (net.role) return this.renderLobby();
    this.body.innerHTML = `
      <div class="mp">
        <div class="mpcol">
          <h3>Public rooms</h3>
          <p class="small">Rooms are announced on public Nostr relays. Gameplay is peer-to-peer (WebRTC), and there is no game server.</p>
          <div id="roomList" class="rooms"><p class="small">Searching…</p></div>
          <div class="buttons"><button id="btnRefresh">Refresh</button></div>
        </div>
        <div class="mpcol">
          <h3>Host or join</h3>
          <label class="check"><input type="checkbox" id="pubRoom" checked/> List my room publicly</label>
          <div class="buttons"><button class="primary" id="btnHost" data-testid="host-room">Host a room</button></div>
          <label>Room code<input id="roomCode" maxlength="6" placeholder="ABC123" autocapitalize="characters" style="text-transform:uppercase" aria-label="Room code"/></label>
          <div class="buttons"><button id="btnJoin" data-testid="join-room">Join room</button></div>
          <details><summary>Direct link (no relays)</summary>
            <p class="small">Exchange two codes by chat/e-mail instead of using relays. One invite per guest.</p>
            <div class="buttons"><button id="btnInvite">Host: create invite</button><button id="btnGuest">Guest: paste invite</button></div>
            <div id="manualArea"></div>
          </details>
        </div>
      </div>
      <div class="status" id="mpStatus" role="status"></div>`;
    $('#btnHost', this.body).onclick = async () => {
      try {
        this.setStatus('Connecting to Nostr relays…');
        await net.hostRoom(this.progress.name, { isPublic: $('#pubRoom', this.body).checked, mission: this.lobbyMission });
        this.renderLobby();
      } catch (e) {
        this.setStatus(e.message);
        net.leave();
      }
    };
    const join = async (code) => {
      if (!code) return this.setStatus('Enter a room code');
      try {
        await net.joinRoom(code, this.progress.name);
        this.renderLobby();
      } catch (e) {
        this.setStatus(e.message);
        net.leave();
      }
    };
    $('#btnJoin', this.body).onclick = () => join($('#roomCode', this.body).value.trim());
    $('#btnRefresh', this.body).onclick = () => this.loadRooms(join);
    $('#btnInvite', this.body).onclick = () => this.manualHost();
    $('#btnGuest', this.body).onclick = () => this.manualGuest();
    this.loadRooms(join);
  }

  async loadRooms(join) {
    const el = $('#roomList', this.body);
    if (!el) return;
    el.innerHTML = '<p class="small">Searching…</p>';
    try {
      const rooms = await this.net.listPublicRooms();
      if (!el.isConnected) return;
      if (!rooms.length) {
        el.innerHTML = '<p class="small">No public rooms right now. Host one and invite friends!</p>';
        return;
      }
      el.innerHTML = rooms
        .map((r) => {
          const m = MISSIONS.find((x) => x.id === r.mission);
          return `<div class="room"><div><b>${esc(r.name)}</b><span>${esc(m ? m.title : r.mission)} · ${Number(r.players) || 1}/${Number(r.max) || 8}</span></div><button data-code="${esc(r.room)}">Join</button></div>`;
        })
        .join('');
      el.querySelectorAll('button[data-code]').forEach((b) => (b.onclick = () => join(b.dataset.code)));
    } catch (e) {
      if (el.isConnected) el.innerHTML = `<p class="small">Could not reach relays: ${esc(e.message)}</p>`;
    }
  }

  async manualHost() {
    const area = this.net.role === 'host' ? $('#lobbyManual', this.body) : $('#manualArea', this.body);
    area.innerHTML = '<p>Creating invite (gathering network candidates)…</p>';
    const code = await this.net.createInvite(this.progress.name);
    area.innerHTML = `
      <label>1 · Send this invite to your friend<textarea readonly id="invCode">${esc(code)}</textarea></label>
      <div class="buttons"><button id="copyInv">Copy</button></div>
      <label>2 · Paste their answer code<textarea id="ansCode" placeholder="answer code…"></textarea></label>
      <div class="buttons"><button class="primary" id="btnConnect">Connect</button></div>`;
    $('#copyInv', area).onclick = () => navigator.clipboard?.writeText(code);
    $('#btnConnect', area).onclick = async () => {
      try {
        await this.net.acceptAnswer($('#ansCode', area).value);
        this.setStatus('Connecting to guest…');
        this.renderLobby();
      } catch (e) {
        this.setStatus(e.message);
      }
    };
  }

  manualGuest() {
    const area = $('#manualArea', this.body);
    area.innerHTML = `
      <label>1 · Paste the host's invite<textarea id="invIn" placeholder="invite code…"></textarea></label>
      <div class="buttons"><button class="primary" id="btnAnswer">Create answer</button></div>
      <div id="ansOut"></div>`;
    $('#btnAnswer', area).onclick = async () => {
      try {
        const ans = await this.net.acceptInvite($('#invIn', area).value, this.progress.name);
        $('#ansOut', area).innerHTML = `<label>2 · Send this answer back to the host<textarea readonly>${esc(ans)}</textarea></label><div class="buttons"><button id="copyAns">Copy</button></div><p>Waiting for the host to connect…</p>`;
        $('#copyAns', area).onclick = () => navigator.clipboard?.writeText(ans);
      } catch (e) {
        this.setStatus('Invalid invite code: ' + e.message);
      }
    };
  }

  renderLobby() {
    const net = this.net;
    if (!net.role) return this.renderMultiplayer();
    const isHost = net.role === 'host';
    const roster = net.roster();
    const options = MISSIONS.map((m) => `<option value="${m.id}" ${m.id === this.lobbyMission ? 'selected' : ''}>${esc(m.title)}</option>`).join('');
    const share = net.room ? `${location.origin}${location.pathname}?room=${net.room}` : '';
    this.body.innerHTML = `
      <div class="lobby">
        <div class="mpcol">
          <h3>${isHost ? 'Your room' : 'Room'} ${net.room ? `<span class="code" data-testid="room-code">${esc(net.room)}</span>` : '<span class="code">direct</span>'}</h3>
          ${share ? `<div class="buttons"><button id="btnShare">Copy invite link</button></div>` : ''}
          <ul class="roster">${roster.map((p) => `<li><i style="background:${esc(p.color)}"></i>${esc(p.name)}${p.host ? ' <em>host</em>' : ''}${p.me ? ' <em>you</em>' : ''}</li>`).join('') || '<li>Waiting for players…</li>'}</ul>
          ${isHost && net.mode === 'manual' ? '<div class="buttons"><button id="btnMoreInv">Invite another pilot</button></div><div id="lobbyManual"></div>' : ''}
        </div>
        <div class="mpcol">
          <h3>Mission</h3>
          ${isHost ? `<select id="lobbyMission" aria-label="Lobby mission">${options}</select>` : `<p class="cur">${esc(MISSIONS.find((m) => m.id === this.lobbyMission)?.title || '')}</p><p class="small">The host picks the mission and starts the session.</p>`}
          <p class="small">Everyone flies the same scenario from offset start positions, with a live PILOTS scoreboard. Press Enter (or 💬) to chat.</p>
          <div class="buttons">${isHost ? '<button class="primary" id="btnLobbyStart" data-testid="lobby-start">Start for everyone ▸</button>' : ''}<button id="btnLeave">Leave</button></div>
        </div>
      </div>
      <div class="status" id="mpStatus" role="status"></div>`;
    if (share) $('#btnShare', this.body).onclick = () => navigator.clipboard?.writeText(share).then(() => this.setStatus('Invite link copied'));
    if (isHost) {
      $('#lobbyMission', this.body).onchange = (e) => {
        this.lobbyMission = e.target.value;
        net.setLobbyMission?.(this.lobbyMission);
        net.send({ t: 'lobby', mission: this.lobbyMission });
      };
      $('#btnLobbyStart', this.body).onclick = () => {
        const slots = {};
        roster.forEach((p, i) => (slots[p.id] = i));
        net.send({ t: 'start', mission: this.lobbyMission, slots });
        this.onStart(this.lobbyMission, { multiplayer: true, slot: slots[net.id] || 0 });
      };
      const more = $('#btnMoreInv', this.body);
      if (more) more.onclick = () => this.manualHost();
    }
    $('#btnLeave', this.body).onclick = () => {
      net.leave();
      this.renderMultiplayer();
    };
  }

  setStatus(s) {
    const el = $('#mpStatus', this.body);
    if (el) el.textContent = s;
  }

  // ------------------------------------------------------------------ settings
  renderSettings() {
    const s = this.progress.settings;
    const slider = (id, label, val) =>
      `<label>${label}<input type="range" id="${id}" min="0" max="1" step="0.05" value="${val}" aria-label="${label}"/></label>`;
    this.body.innerHTML = `
      <div class="settings">
        <label>Graphics quality
          <select id="setQuality">
            ${['low', 'medium', 'high'].map((q) => `<option ${s.quality === q ? 'selected' : ''} value="${q}">${q}</option>`).join('')}
          </select>
          <small>Earth texture resolution, atmosphere samples, shadows, anti-aliasing. Applied on reload.</small>
        </label>
        <label class="check"><input type="checkbox" id="setBloom" ${s.bloom ? 'checked' : ''}/> Bloom / glare</label>
        ${slider('volMaster', 'Master volume', s.master)}
        ${slider('volMusic', 'Music', s.music)}
        ${slider('volSfx', 'Sound effects', s.sfx)}
        <label class="check"><input type="checkbox" id="setMute" ${s.muted ? 'checked' : ''}/> Mute all audio</label>
        <label>Touch controls
          <select id="setTouch">${['auto', 'on', 'off'].map((q) => `<option ${s.touch === q ? 'selected' : ''} value="${q}">${q}</option>`).join('')}</select>
        </label>
        <label class="check"><input type="checkbox" id="setShare" ${s.shareScores ? 'checked' : ''}/> Publish my best scores to the global Nostr leaderboard</label>
        <label>Nostr relays (comma separated, blank = defaults)<input id="setRelays" value="${esc(s.relays || '')}" placeholder="wss://relay.damus.io, wss://nos.lol"/></label>
        <div class="buttons"><button class="primary" id="setApply">Apply &amp; reload</button><button id="setReset">Reset progress</button></div>
      </div>`;
    const live = () => {
      s.bloom = $('#setBloom', this.body).checked;
      s.master = Number($('#volMaster', this.body).value);
      s.music = Number($('#volMusic', this.body).value);
      s.sfx = Number($('#volSfx', this.body).value);
      s.muted = $('#setMute', this.body).checked;
      s.shareScores = $('#setShare', this.body).checked;
      s.touch = $('#setTouch', this.body).value;
      this.progress.save();
      this.onSettings && this.onSettings(s);
    };
    this.body.querySelectorAll('input,select').forEach((el) => el.addEventListener('change', live));
    this.body.querySelectorAll('input[type=range]').forEach((el) => el.addEventListener('input', live));
    $('#setApply', this.body).onclick = () => {
      s.quality = $('#setQuality', this.body).value;
      s.relays = $('#setRelays', this.body).value.trim();
      live();
      location.reload();
    };
    $('#setReset', this.body).onclick = () => {
      if (confirm('Erase all scores, XP and patches?')) {
        const p = this.progress;
        p.bestScores = {};
        p.history = [];
        p.xp = 0;
        p.achievements = {};
        p.daily = {};
        p.flights = 0;
        p.save();
        this.render();
      }
    };
  }

  renderControls() {
    this.body.innerHTML = `
      <div class="howto">
        <div>
          <h3>The physics is real</h3>
          <p>You orbit at ~7.7 km/s. Thrusting <b>prograde</b> raises the opposite side of your orbit; <b>retrograde</b> lowers it. Burns are most efficient at apoapsis/periapsis. To catch something ahead of you, you drop to a <i>lower</i> (faster) orbit.</p>
          <p>Re-entry heating follows the Sutton–Graves relation. Keep the heat shield into the airflow, and use the capsule's lift (roll heads-up) to keep the g-load survivable.</p>
        </div>
        <div>
          <h3>Instruments</h3>
          <p>The <b>navball</b> shows your attitude against the local horizon with markers for orbital directions. SAS modes hold those directions automatically.</p>
          <p><b>Map view</b> shows orbits, apoapsis/periapsis, and ~14 000 tracked satellites and debris. <b>Time warp</b> is limited while thrusting, in the atmosphere, or near the station.</p>
        </div>
        <div>
          <h3>On a phone or tablet</h3>
          <p>Left stick: pitch &amp; yaw. Right stick: RCS translation (switch to roll with ⟳). Slider: throttle. Buttons: SAS modes, stage, camera, map and warp. Landscape works best.</p>
        </div>
        <div>
          <h3>Scoring</h3>
          <p>Every module awards points for objectives, then bonuses for precision, propellant economy and time. Earn ★★★, collect patches, keep your daily streak and climb the global Nostr leaderboard.</p>
        </div>
      </div>
      <div class="buttons"><button id="openHelp">Full key reference</button></div>`;
    $('#openHelp', this.body).onclick = () => document.getElementById('help')?.classList.remove('hidden');
  }
}
