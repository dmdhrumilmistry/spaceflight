import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GamepadController, deadzone, BTN } from '../src/game/gamepad.js';

function fakePad({ axes = [0, 0, 0, 0], pressed = [], values = {} } = {}) {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) || (values[i] || 0) > 0.5, value: values[i] ?? (pressed.includes(i) ? 1 : 0) }));
  return { index: 0, connected: true, axes, buttons, id: 'Test pad' };
}

function setup() {
  let pad = fakePad();
  const actions = [];
  const input = {};
  const gc = new GamepadController({ input, onAction: (a, v) => actions.push(v ? [a, v] : a), getPads: () => [pad] });
  return { gc, input, actions, set: (p) => (pad = p) };
}

test('deadzone removes drift and keeps full deflection', () => {
  assert.equal(deadzone(0.1), 0);
  assert.equal(deadzone(1), 1);
  assert.equal(deadzone(-1), -1);
  assert.ok(deadzone(0.5) > 0 && deadzone(0.5) < 0.5);
});

test('sticks, bumpers and d-pad map to flight axes', () => {
  const { gc, input, set } = setup();
  set(fakePad({ axes: [1, -1, 1, -1], pressed: [BTN.LB, BTN.UP] }));
  gc.poll(1 / 60, 'flight');
  assert.equal(input.pad.yaw, -1); // stick right = yaw right
  assert.equal(input.pad.pitch, -1); // stick up = nose down
  assert.equal(input.pad.roll, 1); // LB = roll left
  assert.equal(input.pad.x, 1); // right stick right = translate right
  assert.equal(input.pad.y, 1); // right stick up = translate up
  assert.equal(input.pad.z, -1); // d-pad up = forward
});

test('triggers return a throttle rate and buttons fire once per press', () => {
  const { gc, actions, set } = setup();
  set(fakePad({ values: { [BTN.RT]: 1 }, pressed: [BTN.A] }));
  assert.equal(gc.poll(1 / 60, 'flight'), 1);
  gc.poll(1 / 60, 'flight'); // still held: no repeat
  set(fakePad({ pressed: [BTN.Y, BTN.RIGHT] }));
  gc.poll(1 / 60, 'flight');
  assert.deepEqual(actions, ['stage', 'sasNext', 'warpUp']);
});

test('menu mode navigates focus and presses buttons', () => {
  const { gc, input, actions, set } = setup();
  set(fakePad({ pressed: [BTN.DOWN] }));
  gc.poll(1 / 60, 'ui');
  set(fakePad({ pressed: [BTN.A] }));
  gc.poll(1 / 60, 'ui');
  assert.deepEqual(actions, [['uiMove', { dx: 0, dy: 1 }], 'uiPress']);
  assert.equal(input.pad.pitch, 0);
});

test('right stick orbits the camera in map view instead of translating', () => {
  const { gc, input, set } = setup();
  set(fakePad({ axes: [0, 0, 1, 0] }));
  gc.poll(0.1, 'map');
  assert.equal(input.pad.x, 0);
  assert.ok(gc.camera.dx > 0);
});
