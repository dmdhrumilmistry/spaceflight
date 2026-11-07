// Game controller support (Gamepad API, "standard" mapping: Xbox, PlayStation,
// Switch Pro and most Bluetooth pads).
//
// Flight                               Menus / overlays
//   Left stick   pitch / yaw             D-pad / left stick  move focus
//   Right stick  RCS translate (map: orbit camera)
//   LB / RB      roll left / right       A  press focused button
//   LT / RT      throttle down / up      B  back / close
//   D-pad ↑ / ↓  translate fwd / aft
//   D-pad ← / →  time warp − / +
//   A  stage (twice for SM) / undock     Y  next SAS mode
//   B  cut engine                        X  SAS on/off
//   L3 camera   R3 precision   View/Back map   Menu/Start pause
//
// Pads are polled once per frame; analog values go into `input.pad`, which
// Game.readControls merges with keyboard, touch and agent inputs.

export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const SAS_CYCLE = ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'target', 'antiTarget'];

export function deadzone(v, dz = 0.14) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  const n = (a - dz) / (1 - dz);
  return Math.sign(v) * n * n; // quadratic response: fine control near centre
}

export class GamepadController {
  /**
   * @param {object} opts
   * @param {() => (Gamepad|null)[]} [opts.getPads] injectable for tests
   * @param {(action: string, value?: any) => void} opts.onAction
   * @param {(connected: boolean, id: string) => void} [opts.onConnect]
   */
  constructor({ input, onAction, onConnect, getPads }) {
    this.input = input;
    this.onAction = onAction;
    this.onConnect = onConnect || (() => {});
    this.getPads = getPads || (() => (typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()] : []));
    this.prev = [];
    this.active = null; // last-used pad (for rumble)
    this.connected = false;
    this.navRepeat = 0;
    input.pad = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0 };
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', (e) => this.onConnect(true, e.gamepad.id));
      window.addEventListener('gamepaddisconnected', (e) => this.onConnect(false, e.gamepad.id));
    }
  }

  /** Poll pads. `mode` is 'flight' | 'map' | 'ui'. Returns throttle delta request. */
  poll(dt, mode) {
    const pads = this.getPads().filter((p) => p && p.connected !== false);
    const out = this.input.pad;
    out.pitch = out.yaw = out.roll = out.x = out.y = out.z = 0;
    this.throttleRate = 0;
    this.camera = { dx: 0, dy: 0 };
    this.connected = pads.length > 0;
    for (const p of pads) {
      const b = (i) => (p.buttons[i] ? p.buttons[i].value ?? (p.buttons[i].pressed ? 1 : 0) : 0);
      const pressed = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
      const prev = this.prev[p.index] || [];
      const edge = (i) => pressed(i) && !prev[i];
      const ax = (i) => deadzone(p.axes[i] || 0);
      const any = p.buttons.some((x) => x && x.pressed) || p.axes.some((v) => Math.abs(v) > 0.3);
      if (any) this.active = p;

      if (mode === 'ui') {
        this.uiNav(dt, p, edge, ax);
      } else {
        // continuous flight inputs (stick up = nose down, like an aircraft)
        out.pitch += ax(1);
        out.yaw += -ax(0);
        out.roll += b(BTN.LB) - b(BTN.RB);
        if (mode === 'map') {
          this.camera.dx += ax(2) * 600 * dt;
          this.camera.dy += ax(3) * 600 * dt;
        } else {
          out.x += ax(2);
          out.y += -ax(3);
        }
        out.z += (pressed(BTN.DOWN) ? 1 : 0) - (pressed(BTN.UP) ? 1 : 0);
        this.throttleRate += b(BTN.RT) - b(BTN.LT);
        // discrete actions
        if (edge(BTN.A)) this.onAction('stage');
        if (edge(BTN.B)) this.onAction('cut');
        if (edge(BTN.X)) this.onAction('sas');
        if (edge(BTN.Y)) this.onAction('sasNext');
        if (edge(BTN.LEFT)) this.onAction('warpDown');
        if (edge(BTN.RIGHT)) this.onAction('warpUp');
        if (edge(BTN.L3)) this.onAction('camera');
        if (edge(BTN.R3)) this.onAction('precision');
        if (edge(BTN.VIEW)) this.onAction('map');
        if (edge(BTN.MENU)) this.onAction('pause');
      }
      this.prev[p.index] = p.buttons.map((x) => !!(x && x.pressed));
    }
    for (const k of Object.keys(out)) out[k] = Math.max(-1, Math.min(1, out[k]));
    return this.throttleRate;
  }

  /** Spatial focus navigation for menus and dialogs. */
  uiNav(dt, p, edge, ax) {
    if (edge(BTN.A)) this.onAction('uiPress');
    if (edge(BTN.B)) this.onAction('uiBack');
    if (edge(BTN.MENU)) this.onAction('pause');
    let dx = (p.buttons[BTN.RIGHT]?.pressed ? 1 : 0) - (p.buttons[BTN.LEFT]?.pressed ? 1 : 0);
    let dy = (p.buttons[BTN.DOWN]?.pressed ? 1 : 0) - (p.buttons[BTN.UP]?.pressed ? 1 : 0);
    if (!dx && !dy) {
      const sx = ax(0);
      const sy = ax(1);
      if (Math.abs(sx) > 0.4) dx = Math.sign(sx);
      if (Math.abs(sy) > 0.4) dy = Math.sign(sy);
    }
    if (!dx && !dy) {
      this.navRepeat = 0;
      this.navHeld = false;
      return;
    }
    this.navRepeat -= dt;
    if (this.navRepeat > 0) return;
    this.navRepeat = this.navHeld ? 0.14 : 0.35;
    this.navHeld = true;
    this.onAction('uiMove', { dx, dy });
  }

  nextSasMode(current) {
    const i = SAS_CYCLE.indexOf(current);
    return SAS_CYCLE[(i + 1) % SAS_CYCLE.length];
  }

  rumble(strong = 0.6, ms = 150) {
    const a = this.active?.vibrationActuator;
    if (!a || typeof a.playEffect !== 'function') return;
    a.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: Math.min(1, strong * 0.8) }).catch(() => {});
  }
}

/** Move keyboard focus to the nearest visible control in direction (dx, dy). */
export function moveFocus(dx, dy, root = document) {
  const sel = 'button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])';
  const scope = [...root.querySelectorAll('.overlay:not(.hidden), .help:not(.hidden)')].pop() || root.querySelector('.menu:not(.hidden)') || root;
  const items = [...scope.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  if (!items.length) return;
  const cur = document.activeElement && items.includes(document.activeElement) ? document.activeElement : null;
  if (!cur) {
    markFocus(items[0]);
    return;
  }
  const c = cur.getBoundingClientRect();
  const cx = c.left + c.width / 2;
  const cy = c.top + c.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2 - cx;
    const ey = r.top + r.height / 2 - cy;
    const along = ex * dx + ey * dy;
    if (along <= 4) continue;
    const across = Math.abs(ex * dy - ey * dx);
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) {
    markFocus(best);
  }
}

function markFocus(el) {
  document.querySelectorAll('.padfocus').forEach((x) => x.classList.remove('padfocus'));
  el.classList.add('padfocus');
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
