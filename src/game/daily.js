// Daily challenge: one seeded scenario per UTC day, identical for every pilot,
// with its own global leaderboard on Nostr.
import { dayKey } from './progress.js';

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const TEMPLATES = [
  {
    mission: 'docking',
    title: (m) => (m.night ? 'Night docking' : 'Long-range docking'),
    mods: (r) => ({ dist: 120 + Math.round(r() * 160), lateral: 2 + r() * 8, night: r() < 0.4, rcsScale: 0.6 + r() * 0.3 }),
    describe: (m) => `Start ${m.dist} m out, ${m.lateral.toFixed(1)} m off-axis${m.night ? ', in darkness' : ''}, RCS at ${Math.round(m.rcsScale * 100)}%.`,
  },
  {
    mission: 'attitude',
    title: () => 'Violent tumble',
    mods: (r) => ({ tumble: 1.4 + r() * 1.2 }),
    describe: (m) => `Initial tumble ${m.tumble.toFixed(1)}× stronger than training.`,
  },
  {
    mission: 'reentry',
    title: () => 'Precision return',
    mods: (r) => ({ rcsScale: 0.5 + r() * 0.4 }),
    describe: (m) => `Re-entry with only ${Math.round(m.rcsScale * 100)}% RCS propellant.`,
  },
  {
    mission: 'debris',
    title: () => 'Conjunction alert',
    mods: (r) => ({ tca: 240 + Math.round(r() * 300), miss: 40 + Math.round(r() * 150) }),
    describe: (m) => `Debris fragment predicted ${m.miss} m miss in ${Math.round(m.tca / 60)} min.`,
  },
  {
    mission: 'rendezvous',
    title: () => 'Late window',
    mods: (r) => ({ wait: 60 + Math.round(r() * 300) }),
    describe: (m) => `Transfer window opens in ${m.wait} s.`,
  },
];

export function dailyChallenge(date = new Date()) {
  const key = dayKey(date);
  const r = seededRandom(hash('orbital-academy:' + key));
  const t = TEMPLATES[Math.floor(r() * TEMPLATES.length)];
  const mods = t.mods(r);
  return { key, board: `daily-${key}`, mission: t.mission, title: t.title(mods), description: t.describe(mods), mods };
}
