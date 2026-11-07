import './style.css';
import { View } from './render/view.js';
import { Hud } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { Input } from './game/input.js';
import { Game } from './game/game.js';
import { Progress } from './game/progress.js';
import { Net } from './net/net.js';
import { MISSIONS } from './game/missions.js';

const loading = document.getElementById('loading');
const setLoading = (t) => {
  const el = document.getElementById('loadingText');
  if (el) el.textContent = t;
};

async function boot() {
  const progress = new Progress();
  setLoading('Generating planet surface, clouds and star field…');
  await new Promise((r) => setTimeout(r, 30));

  let view;
  try {
    view = new View(document.getElementById('scene'), progress.settings);
  } catch (e) {
    setLoading('WebGL 2 is required to run Orbital Academy. ' + e.message);
    throw e;
  }
  const hud = new Hud(document.getElementById('ui'), view);
  const input = new Input(view.canvas);
  const net = new Net();
  const game = new Game({ view, hud, input, net, progress });

  const menuRoot = document.getElementById('menuLayer');
  const startMission = (id, opts = {}) => {
    menu.show(false);
    game.start(id, opts);
  };
  const menu = new Menu(menuRoot, {
    progress,
    net,
    onStart: startMission,
    onSettings: ({ bloom }) => {
      view.bloom.enabled = bloom;
    },
  });

  const toMenu = () => {
    game.state = 'menu';
    game.menuInit = false;
    hud.hideOverlays();
    hud.show(false);
    menu.show(true);
  };

  hud.onSas = (mode) => {
    if (game.state !== 'flying') return;
    if (game.ship.sasLocked) return hud.toast('SAS unavailable', 'bad');
    game.ship.setSasMode(mode);
  };
  hud.onAction = (a) => {
    if (a === 'resume') {
      game.state = 'flying';
      hud.hideOverlays();
    } else if (a === 'restart') startMission(game.missionId, { multiplayer: game.multiplayer, slot: game.slot });
    else if (a === 'next') {
      const i = MISSIONS.findIndex((m) => m.id === game.missionId);
      const next = MISSIONS[(i + 1) % MISSIONS.length];
      startMission(next.id, { multiplayer: false });
    } else if (a === 'menu') toMenu();
  };

  // ---- multiplayer wiring ----
  hud.onChat = (text) => {
    net.send({ t: 'chat', text });
    hud.chatMessage(`${progress.name} (you)`, text, net.color);
  };
  net.on('chat', (msg, info) => hud.chatMessage(info?.name || 'Pilot', String(msg.text).slice(0, 160), info?.color));
  net.on('state', (msg, info) => game.onRemoteState(msg.from, msg, info));
  net.on('start', (msg) => {
    if (net.role !== 'guest') return;
    startMission(msg.mission, { multiplayer: true, slot: msg.slots?.[net.id] ?? 1 });
  });
  net.on('result', (msg, info) => {
    if (game.multiplayer) hud.toast(`${info?.name || 'Pilot'} ${msg.success ? 'completed' : 'failed'} — ${msg.score} pts`, msg.success ? 'good' : 'bad');
  });
  net.on('joined', (_id, name) => hud.toast(`${name} joined the room`, 'info'));
  net.on('peer-left', (id, info) => {
    game.removeRemote(id);
    if (info) hud.toast(`${info.name} left`, 'warn');
  });
  net.on('host-left', () => hud.toast('Host left — multiplayer session ended', 'bad'));

  // ---- main loop ----
  let last = performance.now();
  const frame = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    try {
      game.update(dt);
    } catch (e) {
      console.error(e);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  loading.classList.add('done');
  setTimeout(() => loading.remove(), 900);
  menu.show(true);

  // debug / automation hooks
  window.__game = game;
  const params = new URLSearchParams(location.search);
  if (params.get('mission')) startMission(params.get('mission'));
}

boot();
