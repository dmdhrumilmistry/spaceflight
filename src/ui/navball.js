// Attitude indicator ("navball"): a textured sphere fixed to the local horizon
// frame, viewed from the spacecraft's nose, with orbital direction markers.
import * as THREE from 'three';

function makeBallTexture() {
  const W = 2048;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#2a5aa8');
  sky.addColorStop(1, '#5fb0ff');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H / 2);
  const gnd = g.createLinearGradient(0, H / 2, 0, H);
  gnd.addColorStop(0, '#c98a45');
  gnd.addColorStop(1, '#6e4220');
  g.fillStyle = gnd;
  g.fillRect(0, H / 2, W, H / 2);
  // pitch lines
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = 'bold 22px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let p = -80; p <= 80; p += 10) {
    if (p === 0) continue;
    const y = H / 2 - (p / 180) * H;
    g.lineWidth = p % 30 === 0 ? 3 : 1.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    if (p % 30 === 0) {
      for (let k = 0; k < 12; k++) g.fillText(String(Math.abs(p)), (k + 0.5) * (W / 12), y - 14 * Math.sign(p));
    }
  }
  // horizon
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(0, H / 2);
  g.lineTo(W, H / 2);
  g.stroke();
  // heading meridians + labels; u = 0.75 - heading/360
  g.font = 'bold 34px sans-serif';
  for (let h = 0; h < 360; h += 15) {
    const u = (((0.75 - h / 360) % 1) + 1) % 1;
    const x = u * W;
    g.strokeStyle = h % 90 === 0 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
    g.lineWidth = h % 90 === 0 ? 3 : 1.5;
    g.beginPath();
    g.moveTo(x, H * 0.05);
    g.lineTo(x, H * 0.95);
    g.stroke();
    if (h % 45 === 0) {
      const label = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[h] ?? String(h);
      g.fillStyle = h % 90 === 0 ? '#ffe680' : '#ffffff';
      g.fillText(label, x, H / 2 - 30);
      g.fillText(label, x, H / 2 + 34);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function markerTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const colors = {
    prograde: '#ffe14d',
    retrograde: '#ffe14d',
    normal: '#d36bff',
    antinormal: '#d36bff',
    radialOut: '#4de1ff',
    radialIn: '#4de1ff',
    target: '#ff4fa3',
    antiTarget: '#ff4fa3',
    maneuver: '#3d7bff',
  };
  g.strokeStyle = colors[kind];
  g.fillStyle = colors[kind];
  g.lineWidth = 9;
  g.lineCap = 'round';
  const C = 64;
  g.shadowColor = 'rgba(0,0,0,0.8)';
  g.shadowBlur = 6;
  const circle = (r) => {
    g.beginPath();
    g.arc(C, C, r, 0, Math.PI * 2);
    g.stroke();
  };
  switch (kind) {
    case 'prograde':
      circle(22);
      g.beginPath();
      g.moveTo(C, C - 22);
      g.lineTo(C, C - 48);
      g.moveTo(C - 22, C);
      g.lineTo(C - 48, C);
      g.moveTo(C + 22, C);
      g.lineTo(C + 48, C);
      g.stroke();
      g.beginPath();
      g.arc(C, C, 4, 0, Math.PI * 2);
      g.fill();
      break;
    case 'retrograde':
      circle(22);
      g.beginPath();
      g.moveTo(C - 14, C - 14);
      g.lineTo(C + 14, C + 14);
      g.moveTo(C + 14, C - 14);
      g.lineTo(C - 14, C + 14);
      g.moveTo(C, C + 22);
      g.lineTo(C, C + 46);
      g.moveTo(C - 20, C - 12);
      g.lineTo(C - 42, C - 26);
      g.moveTo(C + 20, C - 12);
      g.lineTo(C + 42, C - 26);
      g.stroke();
      break;
    case 'normal':
    case 'antinormal': {
      g.beginPath();
      const s = kind === 'normal' ? 1 : -1;
      g.moveTo(C, C - 30 * s);
      g.lineTo(C - 28, C + 20 * s);
      g.lineTo(C + 28, C + 20 * s);
      g.closePath();
      g.stroke();
      if (kind === 'antinormal') {
        g.beginPath();
        g.arc(C, C, 4, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'radialOut':
    case 'radialIn':
      circle(24);
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        g.beginPath();
        if (kind === 'radialOut') {
          g.moveTo(C + Math.cos(a) * 24, C + Math.sin(a) * 24);
          g.lineTo(C + Math.cos(a) * 46, C + Math.sin(a) * 46);
        } else {
          g.moveTo(C + Math.cos(a) * 8, C + Math.sin(a) * 8);
          g.lineTo(C + Math.cos(a) * 22, C + Math.sin(a) * 22);
        }
        g.stroke();
      }
      break;
    case 'target':
    case 'antiTarget':
      circle(26);
      if (kind === 'target') {
        g.beginPath();
        g.arc(C, C, 8, 0, Math.PI * 2);
        g.fill();
      } else {
        g.beginPath();
        g.moveTo(C - 18, C - 18);
        g.lineTo(C + 18, C + 18);
        g.moveTo(C + 18, C - 18);
        g.lineTo(C - 18, C + 18);
        g.stroke();
      }
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        g.beginPath();
        g.moveTo(C + Math.cos(a) * 30, C + Math.sin(a) * 30);
        g.lineTo(C + Math.cos(a) * 46, C + Math.sin(a) * 46);
        g.stroke();
      }
      break;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Navball {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10);
    const mat = new THREE.MeshBasicMaterial({ map: makeBallTexture(), toneMapped: false });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), mat);
    this.scene.add(this.ball);
    this.markers = {};
    for (const k of ['prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'target', 'antiTarget']) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTexture(k), toneMapped: false, depthTest: true, transparent: true }));
      s.scale.setScalar(0.42);
      s.visible = false;
      this.scene.add(s);
      this.markers[k] = s;
    }
    this._m = new THREE.Matrix4();
  }

  update(ship, frame, dirs, targetDir) {
    // ball frame: X = east, Y = up, Z = south
    const south = frame.north.clone().negate();
    this._m.makeBasis(frame.east, frame.up, south);
    this.ball.quaternion.setFromRotationMatrix(this._m);
    const fwd = ship.forward(new THREE.Vector3());
    const up = ship.up(new THREE.Vector3());
    this.camera.position.copy(fwd).multiplyScalar(3.9);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    const set = (k, d) => {
      const s = this.markers[k];
      s.visible = !!d;
      if (d) s.position.copy(d).multiplyScalar(1.05);
    };
    set('prograde', dirs.prograde);
    set('retrograde', dirs.prograde && dirs.prograde.clone().negate());
    set('normal', dirs.normal);
    set('antinormal', dirs.normal && dirs.normal.clone().negate());
    set('radialOut', dirs.radial);
    set('radialIn', dirs.radial && dirs.radial.clone().negate());
    set('target', targetDir);
    set('antiTarget', targetDir && targetDir.clone().negate());
  }

  render(renderer, x, y, size) {
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, size, size);
    renderer.setViewport(x, y, size, size);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.autoClear = prevAuto;
  }
}
