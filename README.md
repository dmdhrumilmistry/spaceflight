# Orbital Academy — 3D Spaceflight Training Simulator

A browser-based, physically grounded spaceflight simulator built around an **astronaut training curriculum**. Fly a crew capsule in low Earth orbit over real NASA imagery of the Earth: attitude control, orbital manoeuvres, rendezvous and **manual docking with the International Space Station**, **orbital-debris avoidance**, and a lifting re-entry with parachute splashdown. Every module is **points-based** with stars, XP, collectible patches, a **daily challenge** and a **global leaderboard**. Fly together with friends in **serverless multiplayer** (WebRTC + Nostr). Works on **desktop and phones**.

**No servers.** The game is a static site on GitHub Pages; multiplayer handshakes and the leaderboard use public Nostr relays; gameplay traffic is peer-to-peer.

## Play

- Hosted: GitHub Pages (deployed automatically from `main` by `.github/workflows/pages.yml`).
- Local:

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # physics tests + every mission flown end-to-end by scripted autopilots
npm run build   # static site in dist/
```

## Training curriculum

| # | Module | What you learn | Scored on |
|---|--------|----------------|-----------|
| 1 | **Attitude Control** | Null a tumble by hand with SAS offline, then point at prograde / radial / normal / retrograde | Speed, RCS propellant, pointing precision |
| 2 | **Orbit Circularization** | Burn at apoapsis to circularize a 230 × 410 km orbit | Δv efficiency vs. the ideal burn, eccentricity |
| 3 | **Hohmann Transfer** | Two-burn transfer 300 km → 420 km with time warp | Δv efficiency vs. ideal Hohmann, final accuracy |
| 4 | **Orbital Rendezvous** | Catch the ISS from a lower orbit using the transfer window and closest-approach predictor | Propellant, time |
| 5 | **Manual Docking** | Final approach to the ISS forward port (IDA-2 on Harmony) with RCS and a docking camera | Lateral/angular error at contact, contact speed, RCS, time |
| 6 | **Debris Avoidance** | A rocket-body fragment on a 98° orbit is on a collision course at ~6 km/s — plan and fly an avoidance manoeuvre | Final miss distance, Δv, how early you acted |
| 7 | **Deorbit & Re-entry** | Deorbit burn, service-module jettison, heat-shield-first lifting entry, drogue + main chutes | Corridor accuracy, heat-shield margin, peak g, splashdown speed |
| ∞ | **Free Flight** | Sandbox next to the ISS — great for multiplayer hangouts | — |

### Progression (why you'll want "one more go")

- ★–★★★ per module, ranks from *Cadet* to *Flight Director*, **XP and pilot levels** (every attempt earns XP).
- **19 patches** to collect (Feather Touch, Bullseye, Night Shift, Close Shave, Penny Pincher, …).
- **Daily challenge**: one seeded scenario per day, identical for every pilot, with its own global ranking and a day-streak counter.
- **Global leaderboards** per module on Nostr (opt-out in Settings).
- Combo streak popups, patch banners, rewarding audio.

## Realism

- **Orbital mechanics:** Newtonian two-body gravity integrated with RK4 at 60 Hz; universal-variable Kepler propagation for high time warp; osculating elements, apsides, time-to-apsis, closest-approach search.
- **Spacecraft:** 12-tonne capsule + service module, rocket-equation propellant use (33 kN main engine, Isp 316 s; RCS Isp 230 s), rigid-body attitude with RCS torques, inertia that changes at staging.
- **SAS:** rate-limited attitude controller with stability hold and prograde/retrograde/normal/radial/target modes, optional heads-up auto-roll for entry.
- **Atmosphere & re-entry:** US-76 density, co-rotating air, drag, aerodynamic stability, L/D ≈ 0.3 lift steered by rolling, Sutton–Graves heating, ablative heat-shield budget, crew g-limits, parachute deployment envelopes.
- **ISS:** modelled to real dimensions — integrated truss, eight solar-array wings that track the sun on alpha/beta gimbals, radiators, Zvezda, Zarya, Unity, Destiny, Harmony (with PMA-2/IDA-2), Columbus, Kibo, Tranquility + Cupola, Canadarm2, docked crew and cargo vehicles — on a 51.6° orbit in LVLH attitude, so relative motion follows Clohessy–Wiltshire dynamics naturally.
- **Space debris:** ~14 000 tracked objects in map view (large LEO constellation shells, sun-synchronous orbits, the 2007 ASAT and 2009 collision debris clouds, GNSS and the geostationary ring) propagated on the GPU; conjunction screening with TCA and miss distance.

## Graphics

- **Real Earth:** NASA Blue Marble surface, NASA/NOAA city lights and a cloud layer extracted from NASA imagery, with per-pixel detail noise up close.
- **Ray-traced planet:** rendered per pixel against an exact sphere (no tessellation artefacts from orbit to splashdown) with logarithmic depth.
- **Physically based atmosphere:** single-scattering Rayleigh + Mie with Earth shadow — blue limbs, sunsets, twilight terminators; ocean sun glint; cloud shadows.
- **Space:** baked Milky Way, 9 000 colour-temperature stars, HDR sun with bloom, ACES tone mapping, MSAA, shadow maps, eclipse lighting and earthshine.
- **Spacecraft effects:** engine plume, individually firing RCS jets, plasma sheath and glowing heat shield, animated parachutes, tumbling debris fragments.

## Sound

Fully synthesized with the Web Audio API (no audio files): a generative ambient score that shifts with the situation (calm cruise, tension on final approach or debris conjunction, drums during re-entry, victory/defeat stingers), structure-borne engine rumble, RCS thumps, wind and plasma roar, docking clunk, master alarm, chute snaps and satisfying score chimes.

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

**Phones & tablets:** left stick = pitch/yaw, right stick = RCS translation, side buttons = roll and fore/aft, slider = throttle, plus STAGE / CUT / CAM / MAP / warp / SAS / pause / chat buttons. One finger orbits the camera, two fingers pinch-zoom. Landscape recommended; can be installed to the home screen.

## Multiplayer (serverless)

- **Star topology over WebRTC**: the host keeps one `RTCPeerConnection` per guest and relays. Two data channels per peer — `rel` (reliable: roster, chat, mission start, results) and `fast` (unordered, no retransmits: 10 Hz spacecraft state). Remote ships are dead-reckoned with Kepler propagation, so pilots on different time-warp rates still see each other in the right place.
- **Signaling over Nostr**: the host listens on a room tag; a guest publishes a `join`; the host replies with an SDP offer **encrypted with NIP-44** to the guest's ephemeral key, and the guest answers the same way (ephemeral kind 25050 events, full ICE, no trickle). Public rooms are announced as expiring kind 30078 events. Default relays: `relay.damus.io`, `nos.lol`, `relay.primal.net`, `nostr.mom`, `relay.snort.social` (configurable in Settings).
- **Direct link fallback**: exchange an invite and an answer code by any chat app — no relays involved.
- Invite links: `https://<pages-url>/?room=ABC123`.
- STUN uses Google's public servers; pilots behind symmetric NAT may need a TURN server (`new Net({ iceServers })`).

## Leaderboard

Best scores are published as signed Nostr events (kind 30078) using a key generated and stored in your browser — no accounts. Boards exist per module and per daily challenge. Scores are self-reported, so treat the global board as friendly competition.

## For AI agents

- `window.orbitalAcademy` exposes telemetry and controls: `missions()`, `start(id)`, `state()`, `controls({...})`, `command(name, value)`, `step(seconds)`. See [`public/llms.txt`](public/llms.txt).
- Coding agents: see [`AGENTS.md`](AGENTS.md) for architecture, conventions and commands.

## Credits

- Earth imagery: NASA Visible Earth — Blue Marble (NASA Goddard Space Flight Center), "Earth's City Lights" (NASA/NOAA DMSP data), Blue Marble clouds. Public domain, via Wikimedia Commons.
- Simplex noise adapted from [webgl-noise](https://github.com/stegu/webgl-noise) (MIT).
- [three.js](https://threejs.org) (MIT), [nostr-tools](https://github.com/nbd-wtf/nostr-tools) (Unlicense).

## Licence

MIT.
