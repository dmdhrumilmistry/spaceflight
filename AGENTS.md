# AGENTS.md — guide for AI coding agents

Orbital Academy is a static, client-only web game (Vite + three.js). There is **no backend**: it deploys to GitHub Pages, multiplayer is WebRTC with signaling over public Nostr relays, and the leaderboard lives on Nostr.

## Commands

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # node --test: orbital mechanics + every mission flown by scripted autopilots (~2 min)
npm run build    # static site in dist/ (deployed by .github/workflows/pages.yml on push to main)
```

Always run `npm test` and `npm run build` before committing. Tests run in plain Node (no browser), so code under `src/sim` and `src/game` must not touch the DOM at import time.

## Layout

| Path | Responsibility |
|------|----------------|
| `src/sim/` | Physics, SI units, double precision, Earth-centred inertial frame (+Y = north pole). `orbit.js` (Kepler/universal variables, elements, closest approach), `spacecraft.js` (RK4 translation, RCS/SAS attitude, propellant, drag/lift/heating, chutes), `atmosphere.js` (US-76), `station.js` (ISS on an analytic orbit, LVLH attitude, colliders). |
| `src/game/` | `game.js` main loop (time warp, docking/collision, scoring, multiplayer state), `missions.js` (curriculum: setup/update/finalize per module), `achievements.js`, `daily.js` (seeded daily challenge), `progress.js` (localStorage profile), `input.js`. |
| `src/render/` | `view.js` (renderer, floating origin, lights, bloom, orbit lines), `earth.js` (ray-traced planet + atmospheric scattering, NASA imagery with procedural fallback), `issModel.js`, `shipModel.js`, `sky.js`, `debrisField.js` (GPU-propagated debris population). |
| `src/ui/` | DOM HUD, navball, menu, touch controls. |
| `src/audio/audio.js` | Web Audio generative music + synthesized SFX (no audio files). |
| `src/net/` | `net.js` WebRTC peer layer (star topology, host relays); `nostr.js` signaling, public rooms, leaderboard (lazy-loaded). |
| `src/agent/api.js` | `window.orbitalAcademy` automation API (see `public/llms.txt`). |
| `public/textures/` | NASA Blue Marble day map + packed data map (R water mask, G clouds, B city lights). Public domain. |

## Conventions

- Body frame of the spacecraft: forward = −Z, up = +Y, right = +X. Station frame: docking port faces −Z (velocity direction), +Y zenith, X along the truss.
- The renderer uses a floating origin: every frame positions are `world − camera` in double precision before going to the GPU. Never put absolute ECI coordinates in a mesh position.
- A mission is an object in `MISSIONS` with `setup(game, slot)`, `update(game, dt)`, `finalize(game)`, optional `onDock`. Use `game.award/penalize/complete`, `game.objectives`, `game.hint`, `game.modifiers` (daily challenge).
- New missions need an end-to-end autopilot test in `test/missions.test.js`.
- Keep mobile in mind: anything heavy must scale with `settings.quality` (`low`/`medium`/`high`).
- Every interactive control has an `aria-label` and most have `data-testid` so browser agents can drive the UI.
