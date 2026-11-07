// On-screen touch controls for phones/tablets: two virtual sticks (attitude,
// RCS translation), roll and fore/aft buttons, throttle slider, action keys.
// Writes into `input.virtual`, which Game.readControls merges with the keyboard.

const $ = (sel, root = document) => root.querySelector(sel);

function stick(el, onMove) {
  const knob = el.querySelector('.knob');
  let id = null;
  let cx = 0;
  let cy = 0;
  const R = () => el.clientWidth / 2;
  const set = (x, y) => {
    const r = R();
    let dx = x - cx;
    let dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d > r) {
      dx *= r / d;
      dy *= r / d;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // small dead zone, quadratic response for fine control
    const nx = dx / r;
    const ny = dy / r;
    const shape = (v) => (Math.abs(v) < 0.08 ? 0 : Math.sign(v) * ((Math.abs(v) - 0.08) / 0.92) ** 1.6);
    onMove(shape(nx), shape(ny));
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    id = e.pointerId;
    el.setPointerCapture(id);
    const b = el.getBoundingClientRect();
    cx = b.left + b.width / 2;
    cy = b.top + b.height / 2;
    set(e.clientX, e.clientY);
    el.classList.add('active');
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId === id) set(e.clientX, e.clientY);
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    knob.style.transform = '';
    el.classList.remove('active');
    onMove(0, 0);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function hold(btn, on, off) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('active');
    on();
  });
  const end = () => {
    btn.classList.remove('active');
    off();
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
}

export class TouchControls {
  constructor(root, { input, onAction, onThrottle }) {
    this.input = input;
    input.virtual = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0 };
    const v = input.virtual;
    const el = document.createElement('div');
    el.className = 'touchui hidden';
    el.innerHTML = `
      <div class="tleft">
        <div class="tbtnrow"><button class="tb" data-hold="rollL" aria-label="Roll left">⟲</button><button class="tb" data-hold="rollR" aria-label="Roll right">⟳</button></div>
        <div class="stick" id="stickAtt" aria-label="Attitude stick"><div class="knob"></div><span>PITCH · YAW</span></div>
      </div>
      <div class="tright">
        <div class="tbtnrow"><button class="tb" data-hold="fwd" aria-label="Translate forward">▲ FWD</button><button class="tb" data-hold="back" aria-label="Translate back">▼ AFT</button></div>
        <div class="stick" id="stickTrans" aria-label="Translation stick"><div class="knob"></div><span>RCS TRANSLATE</span></div>
      </div>
      <div class="throttle" aria-label="Throttle">
        <input type="range" id="tThrottle" min="0" max="1" step="0.01" value="0" orient="vertical" aria-label="Throttle"/>
        <span>THR</span>
      </div>
      <div class="tactions">
        <button class="ta" data-act="stage" aria-label="Stage">STAGE</button>
        <button class="ta" data-act="cut" aria-label="Cut engine">CUT</button>
        <button class="ta" data-act="camera" aria-label="Camera">CAM</button>
        <button class="ta" data-act="map" aria-label="Map">MAP</button>
        <button class="ta" data-act="warpDown" aria-label="Warp down">«</button>
        <button class="ta" data-act="warpUp" aria-label="Warp up">»</button>
        <button class="ta" data-act="sas" aria-label="Toggle SAS">SAS</button>
        <button class="ta" data-act="pause" aria-label="Pause">❚❚</button>
        <button class="ta" data-act="chat" aria-label="Chat">💬</button>
        <button class="ta" data-act="help" aria-label="Help">?</button>
      </div>`;
    root.appendChild(el);
    this.el = el;
    stick($('#stickAtt', el), (x, y) => {
      v.yaw = -x; // right = yaw right (negative body Y rotation)
      v.pitch = y; // pull down (finger down) = nose up, like a flight stick
    });
    stick($('#stickTrans', el), (x, y) => {
      v.x = x;
      v.y = -y;
    });
    const holds = { rollL: ['roll', 1], rollR: ['roll', -1], fwd: ['z', -1], back: ['z', 1] };
    el.querySelectorAll('[data-hold]').forEach((b) => {
      const [k, val] = holds[b.dataset.hold];
      hold(
        b,
        () => (v[k] = val),
        () => (v[k] = 0),
      );
    });
    this.throttle = $('#tThrottle', el);
    this.throttle.addEventListener('input', () => onThrottle(Number(this.throttle.value)));
    this.throttle.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onAction(b.dataset.act);
      }),
    );
  }

  show(on) {
    this.el.classList.toggle('hidden', !on);
  }

  syncThrottle(t) {
    if (document.activeElement !== this.throttle) this.throttle.value = String(t);
  }
}

export function wantsTouch(setting) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
}
