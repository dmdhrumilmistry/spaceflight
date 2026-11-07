import './style.css';
import { View } from './render/view.js';
import { Hud } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { TouchControls, wantsTouch } from './ui/touch.js';
import { Input } from './game/input.js';
import { Game } from './game/game.js';
import { Progress } from './game/progress.js';
import { Net } from './net/net.js';
import { MISSIONS } from './game/missions.js';
import { AudioEngine } from './audio/audio.js';
import { installAgentApi } from './agent/api.js';

const loading = document.getElementById('loading');
const setLoading = (t) => {
  const el = document.getElementById('loadingText');
  if (el) el.textContent = t;
};

function applyLayoutClasses(touch) {
  const b = document.body;
  b.classList.toggle('touch', touch);
  const compact = window.innerWidth < 900 || window.innerHeight < 560;
  b.classList.toggle('compact', compact);
  b.classList.toggle('portrait', window.innerHeight > window.innerWidth);
}

async function boot() {
  const progress = new Progress();
  const params = new URLSearchParams(location.search);
  if (params.get('quality')) progress.settings.quality = params.get('quality');
  setLoading('Generating Earth, atmosphere and star field…');
  await new Promise((r) => setTimeout(r, 30));

  let view;
  try {
    view = new View(document.getElementById('scene'), progress.settings);
  } catch (e) {
    setLoading('This simulator needs WebGL 2. Please try a recent Chrome, Edge, Firefox or Safari. (' + e.message + ')');
    throw e;
  }
  const hud = new Hud(document.getElementById('ui'), view);
  const input = new Input(view.canvas);
  const relays = (progress.settings.relays || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^wss:\/\//.test(s));
  const net = new Net();
  if (relays.length) net.relays = relays;
  const audio = new AudioEngine();
  const game = new Game({ view, hud, input, net, progress });
  game.audio = audio;

  const applySettings = (s) => {
    view.bloom.enabled = s.bloom !== false;
    audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
    audio.setMuted(!!s.muted);
    const t = wantsTouch(s.touch);
    applyLayoutClasses(t);
    touch.show(t && game.state !== 'menu');
  };

  // first user gesture unlocks audio (required on mobile)
  const unlock = () => {
    audio.unlock();
    if (game.state === 'menu') audio.setMood('menu');
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  const menuRoot = document.getElementById('menuLayer');
  const startMission = (id, opts = {}) => {
    menu.show(false);
    game.start(id, opts);
    touch.show(wantsTouch(progress.settings.touch));
  };
  const menu = new Menu(menuRoot, {
    progress,
    net,
    onStart: startMission,
    onSettings: (s) => applySettings(s),
    onUi: (n) => audio.play(n),
  });

  const touch = new TouchControls(document.getElementById('ui'), {
    input,
    onThrottle: (t) => {
      if (game.state === 'flying' || game.state === 'ended') game.ship.throttle = game.ship.stage === 0 ? t : 0;
    },
    onAction: (a) => {
      audio.play('click');
      const ship = game.ship;
      if (a === 'chat') return game.multiplayer ? hud.openChat() : hud.toast('Chat is available in multiplayer rooms', 'info');
      if (a === 'help') return hud.toggleHelp();
      if (a === 'pause') {
        if (game.state === 'flying') {
          game.state = 'paused';
          hud.showPause();
        } else if (game.state === 'paused') {
          game.state = 'flying';
          hud.hideOverlays();
        }
        return;
      }
      if (game.state !== 'flying' && game.state !== 'ended') return;
      if (a === 'stage') game.docked ? game.undock() : game.doStage();
      else if (a === 'cut') ship.throttle = 0;
      else if (a === 'camera') view.cycleCamera();
      else if (a === 'map') view.toggleMap();
      else if (a === 'warpUp') game.changeWarp(1);
      else if (a === 'warpDown') game.changeWarp(-1);
      else if (a === 'sas') ship.sasLocked ? hud.toast('SAS unavailable', 'bad') : (ship.sasEnabled = !ship.sasEnabled);
    },
  });

  const toMenu = () => {
    game.state = 'menu';
    game.menuInit = false;
    hud.hideOverlays();
    hud.show(false);
    touch.show(false);
    menu.show(true);
    audio.setMood('menu');
  };

  hud.onSas = (mode) => {
    if (game.state !== 'flying' && game.state !== 'ended') return;
    if (game.ship.sasLocked) return hud.toast('SAS unavailable', 'bad');
    audio.play('click');
    game.ship.setSasMode(mode);
  };
  hud.onAction = (a) => {
    audio.play('click');
    if (a === 'resume') {
      game.state = 'flying';
      hud.hideOverlays();
    } else if (a === 'restart') startMission(game.missionId, { multiplayer: game.multiplayer, slot: game.slot, daily: game.daily, modifiers: game.modifiers });
    else if (a === 'next') {
      const i = MISSIONS.findIndex((m) => m.id === game.missionId);
      const next = MISSIONS[(i + 1) % MISSIONS.length];
      startMission(next.id, { multiplayer: false });
    } else if (a === 'menu') toMenu();
  };

  // global leaderboard (Nostr): publish only improved results
  game.onScore = (entry) => {
    if (!progress.settings.shareScores || !entry.improved) return;
    net.publishScore({ ...entry, name: progress.name }).catch((e) => console.warn('score publish failed', e));
  };

  // ---- multiplayer wiring ----
  hud.onChat = (text) => {
    net.send({ t: 'chat', text });
    hud.chatMessage(`${progress.name} (you)`, text, net.color);
  };
  net.on('chat', (msg, info) => {
    hud.chatMessage(info?.name || 'Pilot', String(msg.text).slice(0, 160), info?.color);
    audio.play('radio');
  });
  net.on('state', (msg, info) => game.onRemoteState(msg.from, msg, info));
  net.on('start', (msg) => {
    if (net.role !== 'guest') return;
    startMission(msg.mission, { multiplayer: true, slot: msg.slots?.[net.id] ?? 1 });
  });
  net.on('result', (msg, info) => {
    if (game.multiplayer) hud.toast(`${info?.name || 'Pilot'} ${msg.success ? 'completed' : 'failed'} — ${msg.score} pts`, msg.success ? 'good' : 'bad');
  });
  net.on('joined', (_id, name) => {
    hud.toast(`${name} joined the room`, 'info');
    audio.play('radio');
  });
  net.on('peer-left', (id, info) => {
    game.removeRemote(id);
    if (info) hud.toast(`${info.name} left`, 'warn');
  });
  net.on('host-left', () => hud.toast('Host left — multiplayer session ended', 'bad'));

  // ---- layout ----
  applySettings(progress.settings);
  window.addEventListener('resize', () => applyLayoutClasses(wantsTouch(progress.settings.touch)));

  // ---- main loop ----
  let last = performance.now();
  const frame = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    try {
      game.update(dt);
      if (game.state !== 'menu') touch.syncThrottle(game.ship.throttle);
    } catch (e) {
      console.error(e);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  loading.classList.add('done');
  setTimeout(() => loading.remove(), 900);
  menu.show(true);

  // AI / automation hooks
  installAgentApi({ game, input, start: startMission });
  window.__game = game;

  // deep links: ?mission=docking  ·  ?room=ABC123 (join a multiplayer room)
  if (params.get('mission') && MISSIONS.some((m) => m.id === params.get('mission'))) startMission(params.get('mission'));
  else if (params.get('room')) {
    menu.setTab('multiplayer');
    net
      .joinRoom(params.get('room'), progress.name)
      .then(() => menu.renderLobby())
      .catch((e) => menu.setStatus(e.message));
  }
}

boot();
