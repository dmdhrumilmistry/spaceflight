// Procedural modular space station. Station frame: docking port axis = -Z
// (faces prograde), +Y = zenith (away from Earth), X = truss axis.
import * as THREE from 'three';
import { panelTexture, solarCellTexture, foilNormalTexture, dockingTargetTexture } from './textures.js';

export const STATION_PORT = new THREE.Vector3(0, 0, -27.6); // docking interface point (station frame)

function cylZ(r, len, mat, x, y, z, seg = 40) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}

export class StationModel {
  constructor() {
    const group = new THREE.Group();
    this.group = group;
    const modTex = panelTexture('#e4e2dc', '#a8a59e', 21, 6);
    modTex.repeat.set(4, 2);
    const foil = foilNormalTexture(13);
    foil.repeat.set(4, 2);
    const cells = solarCellTexture();
    cells.repeat.set(2, 8);
    const mats = {
      module: new THREE.MeshStandardMaterial({ map: modTex, roughness: 0.55, metalness: 0.1 }),
      blanket: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.75, normalMap: foil, normalScale: new THREE.Vector2(0.5, 0.5) }),
      gold: new THREE.MeshPhysicalMaterial({ color: 0xd4a040, metalness: 1, roughness: 0.3, normalMap: foil }),
      truss: new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.45, metalness: 0.85 }),
      solar: new THREE.MeshPhysicalMaterial({
        map: cells,
        color: 0xffd9a0,
        roughness: 0.3,
        metalness: 0.5,
        clearcoat: 1,
        clearcoatRoughness: 0.15,
        side: THREE.DoubleSide,
      }),
      radiator: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35, metalness: 0.05, side: THREE.DoubleSide }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.6, metalness: 0.6 }),
      port: new THREE.MeshStandardMaterial({ color: 0xbfc3ca, roughness: 0.3, metalness: 0.9 }),
      target: new THREE.MeshStandardMaterial({ map: dockingTargetTexture(), roughness: 0.6, emissive: 0x222222 }),
    };
    this.colliders = []; // boxes in station frame: {min, max}
    const addCollider = (cx, cy, cz, hx, hy, hz) =>
      this.colliders.push({ min: new THREE.Vector3(cx - hx, cy - hy, cz - hz), max: new THREE.Vector3(cx + hx, cy + hy, cz + hz) });

    // pressurised modules along Z
    const modules = [
      { z: -21, len: 7, r: 2.1 }, // forward node
      { z: -11, len: 11, r: 2.2 }, // lab
      { z: 0, len: 6, r: 2.3 }, // central node
      { z: 10, len: 12, r: 2.1 }, // habitat
      { z: 21, len: 9, r: 2.0 }, // service module
    ];
    for (const m of modules) {
      group.add(cylZ(m.r, m.len, mats.module, 0, 0, m.z));
      group.add(cylZ(m.r + 0.06, 0.4, mats.dark, 0, 0, m.z - m.len / 2 + 0.2));
      group.add(cylZ(m.r + 0.06, 0.4, mats.dark, 0, 0, m.z + m.len / 2 - 0.2));
      addCollider(0, 0, m.z, m.r, m.r, m.len / 2);
    }
    // side modules from the central node
    for (const sx of [-1, 1]) {
      const g = new THREE.CylinderGeometry(2.0, 2.0, 9, 40);
      g.rotateZ(Math.PI / 2);
      const m = new THREE.Mesh(g, mats.blanket);
      m.position.set(sx * 7, 0, 0);
      group.add(m);
      addCollider(sx * 7, 0, 0, 4.5, 2, 2);
    }
    // nadir module
    {
      const g = new THREE.CylinderGeometry(1.8, 1.8, 7, 36);
      const m = new THREE.Mesh(g, mats.module);
      m.position.set(0, -5.5, 10);
      group.add(m);
      addCollider(0, -5.5, 10, 1.8, 3.5, 1.8);
    }
    // forward docking adapter + port (faces -Z)
    group.add(cylZ(1.3, 2.2, mats.gold, 0, 0, -25.6));
    group.add(cylZ(0.9, 1.6, mats.port, 0, 0, -26.8));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.08, 12, 48), mats.port);
    ring.position.set(0, 0, -27.6);
    group.add(ring);
    addCollider(0, 0, -25.6, 1.3, 1.3, 1.1);
    // docking target (cross on a standoff above the port, visible from approach)
    const tgt = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), mats.target);
    tgt.position.set(0, 1.8, -25.0);
    tgt.rotation.y = Math.PI; // face -Z
    group.add(tgt);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), mats.truss);
    post.position.set(0, 1.45, -25.0);
    group.add(post);
    const standoff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), mats.dark);
    standoff.rotation.x = Math.PI / 2;
    standoff.position.set(0, 1.8, -25.45);
    group.add(standoff);

    // main truss along X above the central node
    const truss = new THREE.Group();
    const tLen = 110;
    for (const [dy, dz] of [
      [-1.4, -1.4],
      [-1.4, 1.4],
      [1.4, -1.4],
      [1.4, 1.4],
    ]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(tLen, 0.22, 0.22), mats.truss);
      beam.position.set(0, dy, dz);
      truss.add(beam);
    }
    const strutGeo = new THREE.BoxGeometry(0.12, 2.8, 0.12);
    for (let x = -tLen / 2; x <= tLen / 2; x += 3.5) {
      for (const dz of [-1.4, 1.4]) {
        const s = new THREE.Mesh(strutGeo, mats.truss);
        s.position.set(x, 0, dz);
        truss.add(s);
      }
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 3.9), mats.truss);
      d.position.set(x + 1.75, 0, 0);
      d.rotation.y = Math.PI / 4;
      truss.add(d);
    }
    truss.position.set(0, 5.5, 2);
    group.add(truss);
    addCollider(0, 5.5, 2, tLen / 2, 1.6, 1.6);
    const pylon = cylZ(0.8, 3.2, mats.truss, 0, 3, 2, 16);
    pylon.rotation.x = Math.PI / 2;
    group.add(pylon);

    // solar arrays: 4 per side on rotating gimbals
    this.arrays = [];
    for (const sx of [-1, 1]) {
      const gimbal = new THREE.Group();
      gimbal.position.set(sx * 50, 5.5, 2);
      for (const side of [-1, 1]) {
        for (const off of [-7, 7]) {
          const wing = new THREE.Group();
          const mast = new THREE.Mesh(new THREE.BoxGeometry(0.25, 34, 0.25), mats.truss);
          mast.position.y = side * 17.5;
          wing.add(mast);
          for (const px of [-2.6, 2.6]) {
            const panel = new THREE.Mesh(new THREE.BoxGeometry(4.6, 32, 0.05), mats.solar);
            panel.position.set(px, side * 18.5, 0);
            panel.castShadow = true;
            panel.receiveShadow = true;
            wing.add(panel);
          }
          wing.position.x = off;
          gimbal.add(wing);
        }
      }
      group.add(gimbal);
      this.arrays.push(gimbal);
      addCollider(sx * 50, 5.5, 2, 12.5, 36, 3);
    }
    // radiators
    for (const sx of [-1, 1]) {
      const rad = new THREE.Group();
      for (let k = 0; k < 3; k++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.05, 13), mats.radiator);
        p.position.set(0, 0, k * 13.3 - 13.3);
        rad.add(p);
      }
      rad.position.set(sx * 22, 2.0, 2);
      rad.rotation.z = sx * 0.3;
      group.add(rad);
    }

    // navigation lights
    this.lights = [];
    const lightMat = (c) => new THREE.SpriteMaterial({ color: c, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const addLight = (c, x, y, z, phase) => {
      const s = new THREE.Sprite(lightMat(c));
      s.position.set(x, y, z);
      s.scale.setScalar(0.6);
      group.add(s);
      this.lights.push({ s, phase, c });
    };
    addLight(0xff2a2a, -55, 5.5, 2, 0);
    addLight(0x2aff4a, 55, 5.5, 2, 0);
    addLight(0xffffff, 0, 0, -28.2, 0.5);
    addLight(0xffffff, 0, 0, 25.6, 0.25);
    // docking floodlight / approach lights around the port
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      addLight(0x9fd0ff, Math.cos(a) * 1.4, Math.sin(a) * 1.4, -27.0, -1);
    }

    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  update(time, sunDirStation) {
    // rotate the arrays about the truss (X) axis to face the sun
    const a = Math.atan2(-sunDirStation.y, sunDirStation.z);
    for (const g of this.arrays) g.rotation.x = a;
    for (const l of this.lights) {
      if (l.phase < 0) {
        l.s.material.opacity = 0.9;
        continue;
      }
      const on = (time + l.phase) % 1.5 < 0.15;
      l.s.material.opacity = on ? 1 : 0.06;
      l.s.material.color.setHex(l.c).multiplyScalar(on ? 6 : 1);
    }
  }
}
