// Small procedural canvas textures (panel lines, solar cells, foil, glows).
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function panelTexture(base = '#d9dadc', lines = '#9a9ca0', seed = 1, tiles = 8) {
  const [c, g] = canvas(512, 512);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  const step = 512 / tiles;
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      const v = 0.92 + r() * 0.12;
      g.fillStyle = `rgba(${v > 1 ? 255 : 0},${v > 1 ? 255 : 0},${v > 1 ? 255 : 0},${Math.abs(v - 1) * 0.6})`;
      g.fillRect(x * step, y * step, step, step);
    }
  }
  g.strokeStyle = lines;
  g.lineWidth = 2;
  for (let i = 0; i <= tiles; i++) {
    g.beginPath();
    g.moveTo(i * step, 0);
    g.lineTo(i * step, 512);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i * step);
    g.lineTo(512, i * step);
    g.stroke();
  }
  // rivets / details
  g.fillStyle = 'rgba(80,80,80,0.5)';
  for (let i = 0; i < 300; i++) g.fillRect(r() * 512, r() * 512, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function solarCellTexture() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#0b1530';
  g.fillRect(0, 0, 512, 512);
  const n = 16;
  const s = 512 / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const grad = g.createLinearGradient(x * s, y * s, x * s + s, y * s + s);
      grad.addColorStop(0, '#1b2f66');
      grad.addColorStop(1, '#0f1d45');
      g.fillStyle = grad;
      g.fillRect(x * s + 1.5, y * s + 1.5, s - 3, s - 3);
      g.strokeStyle = 'rgba(160,170,200,0.25)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x * s + s / 2, y * s + 2);
      g.lineTo(x * s + s / 2, y * s + s - 2);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Crumpled foil normal map (multi-layer insulation look). */
export function foilNormalTexture(seed = 7) {
  const N = 256;
  const [c, g] = canvas(N, N);
  const r = rng(seed);
  const h = new Float32Array(N * N);
  for (let k = 0; k < 140; k++) {
    const cx = r() * N;
    const cy = r() * N;
    const rad = 6 + r() * 30;
    const amp = (r() - 0.5) * 2;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let dx = Math.abs(x - cx);
        let dy = Math.abs(y - cy);
        dx = Math.min(dx, N - dx);
        dy = Math.min(dy, N - dy);
        const d = Math.max(dx, dy * 0.7 + dx * 0.3);
        if (d < rad) h[y * N + x] += amp * (1 - d / rad);
      }
    }
  }
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const hx = h[y * N + ((x + 1) % N)] - h[y * N + ((x - 1 + N) % N)];
      const hy = h[((y + 1) % N) * N + x] - h[((y - 1 + N) % N) * N + x];
      const nx = -hx * 1.5;
      const ny = -hy * 1.5;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function radialGlowTexture(stops = [
  [0, 'rgba(255,255,255,1)'],
  [0.2, 'rgba(255,240,220,0.6)'],
  [0.5, 'rgba(255,200,150,0.12)'],
  [1, 'rgba(255,180,120,0)'],
]) {
  const [c, g] = canvas(256, 256);
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function ringTexture() {
  const [c, g] = canvas(256, 256);
  const grad = g.createRadialGradient(128, 128, 60, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.75, 'rgba(180,220,255,0.25)');
  grad.addColorStop(0.85, 'rgba(255,190,140,0.2)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function dockingTargetTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#e8e8e8';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#111';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(128, 128, 100, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(128, 30);
  g.lineTo(128, 226);
  g.moveTo(30, 128);
  g.lineTo(226, 128);
  g.stroke();
  g.fillStyle = '#c21';
  g.fillRect(118, 20, 20, 30);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
