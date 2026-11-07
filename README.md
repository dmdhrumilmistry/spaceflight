# Orbital Academy — 3D Spaceflight Training Simulator

A browser-based, physically grounded spaceflight simulator built around an **astronaut training curriculum**. Fly a crew capsule in low Earth orbit, learn attitude control, orbital manoeuvres, rendezvous, manual docking, and a lifting re-entry with parachute landing. Each module is **points-based**: you earn points for objectives and bonuses for precision, propellant economy and time. You can also fly with friends over **WebRTC peer-to-peer multiplayer**.

![modules](https://img.shields.io/badge/modules-6%20%2B%20sandbox-5fd4ff) ![tech](https://img.shields.io/badge/three.js-WebGL2-informational) ![mp](https://img.shields.io/badge/multiplayer-WebRTC-ffb347)

## Quick start

```bash
npm install
npm run dev          # Vite dev server on http://localhost:5173 (single player)
```

For multiplayer with room codes, run the bundled signaling server (it also serves the production build):

```bash
npm start            # = vite build + node server/server.js  →  http://localhost:8787
```

In development you can run `npm run server` in a second terminal; the Vite dev server proxies `/signal` to it.

Run the test suite (orbital mechanics + every mission flown end-to-end by scripted autopilots):

```bash
npm test
```

## Training curriculum

| # | Module | What you learn | Scored on |
|---|--------|----------------|-----------|
| 1 | **Attitude Control** | Null a tumble by hand with SAS offline, then point at prograde / radial / normal / retrograde | Speed, RCS propellant, pointing precision |
| 2 | **Orbit Circularization** | Burn at apoapsis to circularize a 230 × 410 km orbit | Δv efficiency vs. the ideal burn, eccentricity |
| 3 | **Hohmann Transfer** | Two-burn transfer 300 km → 420 km with time warp | Δv efficiency vs. ideal Hohmann, final accuracy |
| 4 | **Orbital Rendezvous** | Phase from a lower orbit, use the transfer window and closest-approach predictor, match velocity | Propellant, time |
| 5 | **Manual Docking** | 120 m final approach with RCS translation and a docking camera | Lateral/angular error at contact, contact speed, RCS, time |
| 6 | **Deorbit & Re-entry** | Deorbit burn, service-module jettison, heat-shield-first lifting entry, drogue + main chutes | Corridor accuracy, heat-shield margin, peak g, splashdown speed |
| ∞ | **Free Flight** | Sandbox near the station — great for multiplayer hangouts | — |

Each module awards up to ★★★. Your best scores add up to a rank: *Cadet → Astronaut Candidate → Mission Specialist → Pilot Astronaut → Commander → Flight Director*. Progress is stored locally in the browser.

## Realism

- **Orbital mechanics:** Newtonian two-body gravity integrated with RK4 at 60 Hz; universal-variable Kepler propagation for high time warp ("on rails"); osculating elements, apsides, time-to-apsis, closest-approach search.
- **Spacecraft:** 12-tonne capsule + service module with real rocket-equation propellant use (main engine 33 kN, Isp 316 s; RCS 230 s), rigid-body attitude dynamics with RCS torques and inertia that changes when the service module is jettisoned.
- **SAS:** rate-limited attitude controller with stability hold and prograde/retrograde/normal/radial/target modes, plus optional heads-up auto-roll for entry.
- **Atmosphere:** US Standard Atmosphere 1976 density table, co-rotating air, drag, aerodynamic stability torque (capsules fly heat-shield first), L/D ≈ 0.3 trimmed lift steered by rolling.
- **Re-entry:** Sutton–Graves stagnation heating, ablative heat-shield budget, unprotected-hull failure if you're not shield-first, crew g-limits, parachute deployment envelopes.
- **Docking:** station on an analytic circular orbit in LVLH attitude (so relative motion follows Clohessy–Wiltshire dynamics naturally), soft-capture tolerances, collision with station structure.

## Graphics

- **Ray-traced planet:** the Earth is rendered per-pixel against an exact sphere — no tessellation artefacts from orbit down to splashdown — and writes logarithmic depth so it composes with the scene.
- **Physically based atmosphere:** single-scattering Rayleigh + Mie with sun-light transmittance and Earth shadow, giving blue limbs, sunsets and twilight terminators.
- **Procedural Earth:** continents, biomes, ice caps, coastlines with per-pixel detail, ocean sun glint, drifting cloud layer with shadows, and city lights on the night side — baked to GPU cube maps at start-up.
- **Space:** baked Milky Way with dust lanes, 9 000 colour-temperature stars, HDR sun, bloom, ACES tone mapping, MSAA.
- **Spacecraft:** procedural PBR capsule, gold MLI foil, solar arrays, engine plume shader, individually firing RCS jets, plasma sheath during re-entry, animated parachutes; a modular space station with sun-tracking arrays and blinking nav lights; eclipse lighting, earthshine and shadow maps.
- **Instruments:** 3D navball with orbital markers, flight data, docking display, map view with orbit lines and apsis markers.

Graphics quality (low/medium/high) is in **Settings**.

## Controls

| Key | Action |
|-----|--------|
| W / S, A / D, Q / E | Pitch, yaw, roll (RCS) |
| H / N, I / K, J / L | Translate forward/back, up/down, left/right |
| R / F, Z / X | Throttle up/down, full/cut |
| T | SAS on/off · **1–9** SAS modes |
| U | SAS auto-roll heads-up (lift vector up) |
| G | RCS on/off · **`** precision controls |
| Space | Stage: jettison service module → drogues → mains (undock when docked) |
| V | Camera: chase / locked / docking cam · **M** map view |
| . / , | Time warp up/down (0 = reset) |
| Mouse drag / wheel | Orbit / zoom camera |
| P / Esc | Pause · **F1** help · **Enter** chat (multiplayer) |

## Multiplayer (WebRTC)

The game uses a **star topology**: the room host keeps one `RTCPeerConnection` per guest and relays messages. Each peer has two data channels — `rel` (reliable/ordered: roster, chat, mission start, results) and `fast` (unordered, no retransmits: 10 Hz spacecraft state). Remote spacecraft are dead-reckoned with Kepler propagation, so pilots using different time-warp rates still see each other in the right place.

Two ways to connect:

1. **Online room** — start `npm start` (or deploy `server/server.js` anywhere that runs Node). Host clicks *Create room*, shares the 5-letter code, friends *Join*. The server only relays the WebRTC handshake; gameplay is peer-to-peer.
2. **Direct link (no server)** — host clicks *create invite* and sends the code; the guest pastes it and sends back an *answer* code. Works when the game is hosted as static files (e.g. GitHub Pages).

The host picks the module and starts it for everyone; each pilot gets an offset start position, a live PILOTS scoreboard and chat. STUN uses Google's public servers; peers behind symmetric NAT may need a TURN server (`new Net({ iceServers })` in `src/net/net.js`).

## Project layout

```
src/
  sim/       constants, orbit (Kepler, elements, closest approach), atmosphere, spacecraft, station
  render/    view (renderer, floating origin, lights, post-fx), earth (bake + ray-traced shader),
             sky, shipModel, stationModel, textures, noise
  game/      game loop, missions & scoring, input, progress
  ui/        hud, navball, menu
  net/       WebRTC peer layer
server/      static file server + WebSocket signaling relay
test/        physics tests and end-to-end mission tests
```

The renderer uses a **floating origin**: all physics is in double precision in an Earth-centred inertial frame, and every frame the scene is rebuilt relative to the camera, so centimetre-level docking and 400 km orbital views share one scene without jitter.

## Licence

MIT. Simplex noise is adapted from [webgl-noise](https://github.com/stegu/webgl-noise) (MIT).
