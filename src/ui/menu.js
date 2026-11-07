// Main menu: pilot profile, training missions, multiplayer lobby, settings.
import { MISSIONS, rankFor } from '../game/missions.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Menu {
  constructor(root, { progress, net, onStart, onSettings }) {
    this.root = root;
    this.progress = progress;
    this.net = net;
    this.onStart = onStart;
    this.onSettings = onSettings;
    this.tab = 'training';
    this.lobbyMission = 'docking';
    root.innerHTML = `
      <div class="menu" id="menuRoot">
        <header>
          <div class="logo"><span class="ring"></span><div><h1>ORBITAL ACADEMY</h1><p>Astronaut training simulator</p></div></div>
          <div class="pilot" id="pilotCard"></div>
        </header>
        <nav>
          <button data-tab="training" class="active">Training</button>
          <button data-tab="multiplayer">Multiplayer</button>
          <button data-tab="settings">Settings</button>
          <button data-tab="controls">How to fly</button>
        </nav>
        <section id="tabBody"></section>
        <footer>Real two-body orbital mechanics · RK4 integration · US-76 atmosphere · Sutton–Graves heating · WebRTC peer-to-peer</footer>
      </div>`;
    this.el = root.firstElementChild;
    this.body = $('#tabBody', root);
    root.querySelectorAll('nav button').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab;
        root.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
        this.render();
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

  show(on) {
    this.el.classList.toggle('hidden', !on);
    if (on) this.render();
  }

  renderPilot() {
    const p = this.progress;
    const rank = rankFor(p.total);
    $('#pilotCard', this.root).innerHTML = `
      <label>Callsign <input id="pilotName" maxlength="20" value="${esc(p.name)}"/></label>
      <div class="rank">${esc(rank.name)}</div>
      <div class="totals"><b>${p.total}</b> pts · <b>${p.totalStars}</b>/18 ★</div>`;
    $('#pilotName', this.root).addEventListener('change', (e) => {
      p.name = e.target.value.trim().slice(0, 20) || p.name;
      p.save();
    });
  }

  render() {
    this.renderPilot();
    if (this.tab === 'training') this.renderTraining();
    else if (this.tab === 'multiplayer') this.renderMultiplayer();
    else if (this.tab === 'settings') this.renderSettings();
    else this.renderControls();
  }

  renderTraining() {
    const cards = MISSIONS.map((m, i) => {
      const best = this.progress.best(m.id);
      const stars = [0, 1, 2].map((k) => `<span class="${best && k < best.stars ? 'on' : ''}">★</span>`).join('');
      const diff = m.difficulty ? '●'.repeat(m.difficulty) + '○'.repeat(5 - m.difficulty) : 'sandbox';
      return `
        <div class="mcard" data-id="${m.id}">
          <div class="num">${m.free ? '∞' : String(i + 1).padStart(2, '0')}</div>
          <div class="tag">${esc(m.tag)}</div>
          <h3>${esc(m.title)}</h3>
          <p>${esc(m.summary)}</p>
          <div class="meta"><span class="diff">${diff}</span>${m.free ? '' : `<span class="stars">${stars}</span><span class="best">${best ? best.score + ' pts' : '—'}</span>`}</div>
          <button class="primary fly">Fly ▸</button>
        </div>`;
    }).join('');
    this.body.innerHTML = `<div class="grid">${cards}</div>`;
    this.body.querySelectorAll('.mcard').forEach((c) => {
      c.querySelector('.fly').addEventListener('click', () => this.onStart(c.dataset.id, { multiplayer: false }));
    });
  }

  defaultSignalUrl() {
    if (this.progress.settings.signalUrl) return this.progress.settings.signalUrl;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/signal`;
  }

  renderMultiplayer() {
    const net = this.net;
    if (net.role) return this.renderLobby();
    this.body.innerHTML = `
      <div class="mp">
        <div class="mpcol">
          <h3>Online room</h3>
          <p>Uses the bundled signaling server (<code>npm start</code>) to exchange WebRTC offers. Gameplay data flows peer-to-peer.</p>
          <label>Signaling server<input id="sigUrl" value="${esc(this.defaultSignalUrl())}"/></label>
          <div class="buttons"><button class="primary" id="btnHost">Create room</button></div>
          <label>Room code<input id="roomCode" maxlength="5" placeholder="ABCDE" style="text-transform:uppercase"/></label>
          <div class="buttons"><button id="btnJoin">Join room</button></div>
        </div>
        <div class="mpcol">
          <h3>Direct link (no server)</h3>
          <p>Host creates an invite code and sends it to a friend (chat, e-mail…). The friend pastes it and sends back an answer code. One invite per guest.</p>
          <div class="buttons"><button id="btnInvite">Host: create invite</button><button id="btnGuest">Guest: paste invite</button></div>
          <div id="manualArea"></div>
        </div>
      </div>
      <div class="status" id="mpStatus"></div>`;
    $('#btnHost', this.body).onclick = async () => {
      const url = $('#sigUrl', this.body).value.trim();
      this.saveSignal(url);
      try {
        this.setStatus('Connecting…');
        const room = await net.hostRoom(url, this.progress.name);
        this.setStatus(`Room ${room} created`);
        this.renderLobby();
      } catch (e) {
        this.setStatus(e.message);
        net.leave();
      }
    };
    $('#btnJoin', this.body).onclick = async () => {
      const url = $('#sigUrl', this.body).value.trim();
      const code = $('#roomCode', this.body).value.trim();
      if (!code) return this.setStatus('Enter a room code');
      this.saveSignal(url);
      try {
        this.setStatus('Connecting…');
        await net.joinRoom(url, code, this.progress.name);
        this.renderLobby();
      } catch (e) {
        this.setStatus(e.message);
        net.leave();
      }
    };
    $('#btnInvite', this.body).onclick = () => this.manualHost();
    $('#btnGuest', this.body).onclick = () => this.manualGuest();
  }

  saveSignal(url) {
    this.progress.settings.signalUrl = url;
    this.progress.save();
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
    if (this.net.role === 'host' && !$('#lobbyManual', this.body)) this.renderLobby();
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
        this.net.on('roster', () => this.tab === 'multiplayer' && this.renderLobby());
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
    this.body.innerHTML = `
      <div class="lobby">
        <div class="mpcol">
          <h3>${isHost ? 'Your room' : 'Room'} ${net.room ? `<span class="code">${esc(net.room)}</span>` : '<span class="code">direct</span>'}</h3>
          <ul class="roster">${roster.map((p) => `<li><i style="background:${esc(p.color)}"></i>${esc(p.name)}${p.host ? ' <em>host</em>' : ''}${p.me ? ' <em>you</em>' : ''}</li>`).join('') || '<li>Waiting for players…</li>'}</ul>
          ${isHost && net.mode === 'manual' ? '<div class="buttons"><button id="btnMoreInv">Invite another pilot</button></div><div id="lobbyManual"></div>' : ''}
        </div>
        <div class="mpcol">
          <h3>Mission</h3>
          ${isHost ? `<select id="lobbyMission">${options}</select>` : `<p class="cur">${esc(MISSIONS.find((m) => m.id === this.lobbyMission)?.title || '')}</p><p>The host picks the mission and starts the session.</p>`}
          <p class="small">Everyone flies the same scenario from offset start positions. Points are compared live on the PILOTS scoreboard; the chat opens with Enter.</p>
          <div class="buttons">${isHost ? '<button class="primary" id="btnLobbyStart">Start mission for everyone ▸</button>' : ''}<button id="btnLeave">Leave</button></div>
        </div>
      </div>
      <div class="status" id="mpStatus"></div>`;
    if (isHost) {
      $('#lobbyMission', this.body).onchange = (e) => {
        this.lobbyMission = e.target.value;
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

  renderSettings() {
    const s = this.progress.settings;
    this.body.innerHTML = `
      <div class="settings">
        <label>Graphics quality
          <select id="setQuality">
            ${['low', 'medium', 'high'].map((q) => `<option ${s.quality === q ? 'selected' : ''} value="${q}">${q}</option>`).join('')}
          </select>
          <small>Planet texture resolution, atmosphere samples, shadows, MSAA. Applied on reload.</small>
        </label>
        <label class="check"><input type="checkbox" id="setBloom" ${s.bloom ? 'checked' : ''}/> Bloom / glare</label>
        <div class="buttons"><button class="primary" id="setApply">Apply &amp; reload</button><button id="setReset">Reset progress</button></div>
      </div>`;
    $('#setApply', this.body).onclick = () => {
      s.quality = $('#setQuality', this.body).value;
      s.bloom = $('#setBloom', this.body).checked;
      this.progress.save();
      location.reload();
    };
    $('#setBloom', this.body).onchange = (e) => this.onSettings && this.onSettings({ bloom: e.target.checked });
    $('#setReset', this.body).onclick = () => {
      if (confirm('Erase all scores and stars?')) {
        this.progress.bestScores = {};
        this.progress.history = [];
        this.progress.save();
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
          <p>The <b>navball</b> shows your attitude against the local horizon with markers for orbital directions. SAS modes (keys 1–9) hold those directions automatically.</p>
          <p>Use <b>map view (M)</b> to see orbits, apoapsis and periapsis. <b>Time warp</b> (. and ,) is limited while thrusting, in the atmosphere, or near the station.</p>
        </div>
        <div>
          <h3>Scoring</h3>
          <p>Every module awards points for objectives, then bonuses for precision, propellant economy and time. Earn up to 3 ★ per module and climb from <i>Cadet</i> to <i>Flight Director</i>.</p>
        </div>
      </div>
      <div class="buttons"><button id="openHelp">Full key reference</button></div>`;
    $('#openHelp', this.body).onclick = () => document.getElementById('help')?.classList.remove('hidden');
  }
}
