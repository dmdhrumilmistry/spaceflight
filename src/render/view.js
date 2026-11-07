// Main 3D view: renderer, post-processing, floating-origin scene graph,
// cameras, lighting (sun, eclipse, earthshine), orbit lines.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Earth } from './earth.js';
import { Sky } from './sky.js';
import { ShipModel } from './shipModel.js';
import { StationModel } from './stationModel.js';
import { Navball } from '../ui/navball.js';
import { R_EARTH, SUN_DIR } from '../sim/constants.js';
import { localFrame, sampleOrbit } from '../sim/orbit.js';
import { radialGlowTexture } from './textures.js';

const tmp = new THREE.Vector3();

export class View {
  constructor(container, settings) {
    this.settings = settings;
    const q = settings.quality;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    const pr = Math.min(window.devicePixelRatio, q === 'low' ? 1 : q === 'medium' ? 1.5 : 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = q !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1e12);
    this.scene.add(this.camera);

    this.sunDir = new THREE.Vector3(...SUN_DIR);
    this.earth = new Earth(this.renderer, { quality: q });
    this.scene.add(this.earth.mesh);
    this.sky = new Sky(this.renderer, this.scene, { quality: q });

    // ---- lights ----
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 3.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(q === 'high' || q === 'ultra' ? 4096 : 2048, q === 'high' || q === 'ultra' ? 4096 : 2048);
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.03;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.earthLight = new THREE.DirectionalLight(0x6f9dff, 0.6);
    this.scene.add(this.earthLight);
    this.scene.add(this.earthLight.target);
    this.ambient = new THREE.AmbientLight(0x1a2030, 0.25);
    this.scene.add(this.ambient);

    // environment map for PBR reflections (Earth below, black space, sun)
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envScene = new THREE.Scene();
    this.envUniforms = { uUp: { value: new THREE.Vector3(0, 1, 0) }, uSun: { value: this.sunDir.clone() }, uDay: { value: 1 } };
    const envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: this.envUniforms,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: `varying vec3 vD; uniform vec3 uUp; uniform vec3 uSun; uniform float uDay;
        void main(){
          float e = dot(vD, -uUp);
          float earth = smoothstep(0.25, 0.32, e);
          vec3 c = mix(vec3(0.0), vec3(0.09,0.16,0.3)*uDay + vec3(0.005,0.004,0.002), earth);
          c += vec3(0.25,0.4,0.8) * 0.15 * uDay * exp(-pow((e-0.29)/0.03,2.0));
          float s = max(dot(vD, uSun), 0.0);
          c += vec3(1.0,0.95,0.85) * pow(s, 800.0) * 400.0;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), envMat));
    this.envTimer = 0;
    this.envRT = null;

    // ---- player ship ----
    this.shipModel = new ShipModel();
    this.scene.add(this.shipModel.group);
    this.scene.add(this.shipModel.plasma);
    this.station = null;
    this.remoteModels = new Map();
    this.debris = [];

    // ---- orbit lines ----
    this.orbitLines = {};
    this.lineMaterials = [];
    for (const [k, color] of [
      ['ship', 0x44d8ff],
      ['target', 0xff4fa3],
    ]) {
      const mat = new LineMaterial({ color, linewidth: 2.2, transparent: true, opacity: 0.9, depthTest: true, worldUnits: false });
      mat.resolution.set(window.innerWidth, window.innerHeight);
      const line = new Line2(new LineGeometry(), mat);
      line.frustumCulled = false;
      line.visible = false;
      line.renderOrder = 2;
      this.scene.add(line);
      this.orbitLines[k] = line;
      this.lineMaterials.push(mat);
    }

    // map-view icon for the ship (visible at large distances)
    this.mapIcon = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: radialGlowTexture(), color: 0x7fe8ff, depthTest: false, transparent: true, sizeAttenuation: false }),
    );
    this.mapIcon.scale.setScalar(0.035);
    this.mapIcon.visible = false;
    this.mapIcon.renderOrder = 10;
    this.scene.add(this.mapIcon);

    // ---- post processing ----
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q === 'low' ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.6, 0.92);
    this.bloom.enabled = settings.bloom !== false;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.navball = new Navball();
    this.navballRect = null;

    // ---- camera state ----
    this.camMode = 'chase'; // chase | locked | cockpit | map
    this.prevCamMode = 'chase';
    this.orbitCam = { yaw: 0.6, pitch: 0.25, dist: 32 };
    this.mapCam = { yaw: 0.4, pitch: 0.5, dist: 3.2e7 };
    this.shake = 0;
    this.camWorld = new THREE.Vector3();
    this.origin = new THREE.Vector3();
    this.time = 0;

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    for (const m of this.lineMaterials) m.resolution.set(w, h);
  }

  setStation(enabled) {
    if (enabled && !this.station) {
      this.station = new StationModel();
      this.scene.add(this.station.group);
    }
    if (this.station) this.station.group.visible = enabled;
  }

  getRemoteModel(id, tint) {
    let m = this.remoteModels.get(id);
    if (!m) {
      m = new ShipModel({ tint });
      this.scene.add(m.group);
      this.scene.add(m.plasma);
      this.remoteModels.set(id, m);
    }
    return m;
  }

  removeRemote(id) {
    const m = this.remoteModels.get(id);
    if (m) {
      this.scene.remove(m.group);
      this.scene.remove(m.plasma);
      this.remoteModels.delete(id);
    }
  }

  spawnDebris(object, r, v, q) {
    this.scene.add(object);
    this.debris.push({ object, r: r.clone(), v: v.clone(), q: q.clone(), w: new THREE.Vector3(0.05, 0.08, -0.03), age: 0 });
  }

  cycleCamera() {
    const order = ['chase', 'locked', 'cockpit'];
    if (this.camMode === 'map') this.camMode = this.prevCamMode;
    const i = order.indexOf(this.camMode);
    this.camMode = order[(i + 1) % order.length];
    if (this.camMode === 'cockpit') this.orbitCam.dist = Math.max(this.orbitCam.dist, 12);
  }

  toggleMap() {
    if (this.camMode === 'map') this.camMode = this.prevCamMode;
    else {
      this.prevCamMode = this.camMode;
      this.camMode = 'map';
    }
  }

  orbitInput(dx, dy) {
    const c = this.camMode === 'map' ? this.mapCam : this.orbitCam;
    c.yaw -= dx * 0.005;
    c.pitch = Math.max(-1.5, Math.min(1.5, c.pitch + dy * 0.005));
  }

  zoomInput(delta) {
    if (this.camMode === 'map') {
      this.mapCam.dist = Math.max(R_EARTH * 1.2, Math.min(2e9, this.mapCam.dist * Math.exp(delta * 0.0012)));
    } else {
      this.orbitCam.dist = Math.max(8, Math.min(2500, this.orbitCam.dist * Math.exp(delta * 0.0012)));
    }
  }

  /** Project an inertial-frame position to screen pixels (null if behind). */
  project(world) {
    tmp.copy(world).sub(this.origin).project(this.camera);
    if (tmp.z > 1 || tmp.z < -1) return null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    return { x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, inFront: true };
  }
  /** Signed: is the point in front of the camera? */
  inFront(world) {
    tmp.copy(world).sub(this.origin);
    const f = this.camera.getWorldDirection(new THREE.Vector3());
    return tmp.dot(f) > 0;
  }

  updateOrbitLine(key, r, v, visible) {
    const line = this.orbitLines[key];
    if (!visible || !r) {
      line.visible = false;
      return;
    }
    const { points } = sampleOrbit(r, v, 360);
    if (points.length < 6) {
      line.visible = false;
      return;
    }
    const geo = new LineGeometry();
    geo.setPositions(points);
    line.geometry.dispose();
    line.geometry = geo;
    line.computeLineDistances();
    line.visible = true;
  }

  computeEclipse(r) {
    // fraction of sun visible from position r (soft shadow through the atmosphere)
    const d = r.dot(this.sunDir);
    if (d > 0) return 1;
    const perp = tmp.copy(r).addScaledVector(this.sunDir, -d).length();
    return THREE.MathUtils.smoothstep(perp, R_EARTH + 5000, R_EARTH + 60000);
  }

  /**
   * Render one frame.
   * state: { simTime, ship, station:{r,q,model}, target, remotes:[{id,r,q,ship-like}], dt }
   */
  render(state) {
    const { ship, simTime, dt } = state;
    this.time += dt;
    const frame = localFrame(ship.r);

    // ---------- camera placement (inertial, double precision) ----------
    const cam = this.camera;
    let target = ship.r;
    const shipQ = ship.q;
    let up = frame.up.clone();
    if (this.camMode === 'map') {
      const c = this.mapCam;
      target = state.mapFocus || new THREE.Vector3();
      const off = new THREE.Vector3(Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)).multiplyScalar(c.dist);
      this.camWorld.copy(target).add(off);
      up.set(0, 1, 0);
      cam.near = 1000;
      cam.fov = 50;
    } else if (this.camMode === 'cockpit') {
      const off = new THREE.Vector3(0, 0, -3.35).applyQuaternion(shipQ);
      this.camWorld.copy(ship.r).add(off);
      up = new THREE.Vector3(0, 1, 0).applyQuaternion(shipQ);
      cam.near = 0.05;
      cam.fov = 55;
    } else {
      const c = this.orbitCam;
      const local = new THREE.Vector3(Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)).multiplyScalar(c.dist);
      let off;
      if (this.camMode === 'locked') {
        off = local.applyQuaternion(shipQ);
        up = new THREE.Vector3(0, 1, 0).applyQuaternion(shipQ);
      } else {
        // horizon frame: x = east, y = up, z = south
        off = frame.east.clone().multiplyScalar(local.x).addScaledVector(frame.up, local.y).addScaledVector(frame.north, -local.z);
      }
      this.camWorld.copy(ship.r).add(off);
      // keep the camera above the ground
      const minR = R_EARTH + 2;
      if (this.camWorld.length() < minR) this.camWorld.setLength(minR);
      cam.near = 0.1;
      cam.fov = 60;
    }
    cam.updateProjectionMatrix();
    this.origin.copy(this.camWorld);
    cam.position.set(0, 0, 0);
    cam.up.copy(up);
    const lookRel = tmp.copy(target).sub(this.origin);
    if (this.camMode === 'cockpit') lookRel.copy(ship.forward(new THREE.Vector3()));
    cam.lookAt(lookRel);
    if (this.shake > 0.001 && this.camMode !== 'map') {
      cam.rotation.x += (Math.random() - 0.5) * this.shake * 0.01;
      cam.rotation.y += (Math.random() - 0.5) * this.shake * 0.01;
    }
    cam.updateMatrixWorld();

    // ---------- world objects relative to origin ----------
    const O = this.origin;
    this.earth.update(simTime, this.camWorld, O, cam, this.sunDir, window.innerHeight);
    const eclipse = this.computeEclipse(ship.r);
    const camEclipse = this.computeEclipse(this.camWorld);
    this.sky.update(this.sunDir, 1 - camEclipse * (this.camMode === 'map' ? 0.3 : 1), this.renderer.getPixelRatio());

    const sm = this.shipModel;
    sm.group.position.copy(ship.r).sub(O);
    sm.group.quaternion.copy(shipQ);
    sm.group.visible = this.camMode !== 'cockpit' || true;
    sm.update(ship, this.time, dt);
    this.placePlasma(sm, ship);

    // station
    if (this.station && state.station) {
      const st = this.station;
      st.group.position.copy(state.station.r).sub(O);
      st.group.quaternion.copy(state.station.q);
      const sunLocal = this.sunDir.clone().applyQuaternion(state.station.q.clone().invert());
      st.update(this.time, sunLocal);
    }

    // remote players
    for (const rem of state.remotes || []) {
      const m = this.getRemoteModel(rem.id, rem.color);
      m.group.position.copy(rem.r).sub(O);
      m.group.quaternion.copy(rem.q);
      m.update(rem.shipLike, this.time, dt);
      this.placePlasma(m, rem.shipLike);
    }

    // debris (jettisoned modules) drift away
    for (const d of this.debris) {
      d.age += dt;
      d.r.addScaledVector(d.v, dt);
      const wq = new THREE.Quaternion().setFromAxisAngle(d.w.clone().normalize(), d.w.length() * dt);
      d.q.multiply(wq);
      d.object.position.copy(d.r).sub(O);
      d.object.quaternion.copy(d.q);
    }
    this.debris = this.debris.filter((d) => {
      if (d.age > 300) {
        this.scene.remove(d.object);
        return false;
      }
      return true;
    });

    // ---------- lighting ----------
    const shipRel = tmp.copy(ship.r).sub(O);
    const focus = shipRel.clone();
    const nearStation = state.station && state.station.r.distanceTo(ship.r) < 400;
    const ext = nearStation ? 75 : 14;
    this.sunLight.position.copy(focus).addScaledVector(this.sunDir, 600);
    this.sunLight.target.position.copy(focus);
    const sc = this.sunLight.shadow.camera;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 1;
    sc.far = 1400;
    sc.updateProjectionMatrix();
    if (nearStation) {
      // centre shadow frustum between ship and station
      const mid = state.station.r.clone().sub(O).add(focus).multiplyScalar(0.5);
      this.sunLight.position.copy(mid).addScaledVector(this.sunDir, 600);
      this.sunLight.target.position.copy(mid);
    }
    this.sunLight.intensity = 2.6 * eclipse;
    // earthshine: from below, scaled by how much of the visible Earth is lit
    const dayFactor = Math.max(0, 0.25 + 0.75 * frame.up.dot(this.sunDir));
    this.earthLight.position.copy(focus).addScaledVector(frame.up, -100);
    this.earthLight.target.position.copy(focus);
    this.earthLight.intensity = 0.9 * dayFactor * (1 - Math.min(1, ship.altitude / 4e7));
    this.ambient.intensity = 0.12 + 0.15 * (1 - eclipse);

    // environment map refresh
    this.envTimer -= dt;
    if (this.envTimer <= 0 && this.renderer.getContext()) {
      this.envTimer = 1.5;
      this.envUniforms.uUp.value.copy(frame.up);
      this.envUniforms.uSun.value.copy(this.sunDir);
      this.envUniforms.uDay.value = dayFactor * eclipse + 0.15;
      const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
      if (this.envRT) this.envRT.dispose();
      this.envRT = next;
      this.scene.environment = next.texture;
      this.scene.environmentIntensity = 0.45;
    }

    // ---------- orbit lines / map view ----------
    const isMap = this.camMode === 'map';
    for (const k of Object.keys(this.orbitLines)) {
      const l = this.orbitLines[k];
      l.position.set(-O.x, -O.y, -O.z);
      l.material.visible = isMap;
    }
    this.mapIcon.visible = isMap;
    this.mapIcon.position.copy(ship.r).sub(O);

    // ---------- render ----------
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    this.composer.render(dt);

    // navball overlay
    if (state.navball && this.navballRect) {
      this.navball.update(ship, frame, state.navball.dirs, state.navball.targetDir);
      const { x, y, size } = this.navballRect;
      this.navball.render(this.renderer, x, window.innerHeight - y - size, size);
    }
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    return { eclipse };
  }

  placePlasma(model, ship) {
    const p = model.plasma;
    if (!p.visible) return;
    p.position.copy(model.group.position);
    const v = ship.airVel || ship.v;
    if (v && v.lengthSq() > 1) p.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v.clone().normalize());
  }
}
