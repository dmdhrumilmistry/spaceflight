// Persistent pilot profile: best scores, stars, settings (localStorage).
const KEY = 'orbital-academy-v1';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return null;
}

export class Progress {
  constructor() {
    const d = load() || {};
    this.name = d.name || `Pilot-${Math.floor(100 + Math.random() * 900)}`;
    this.bestScores = d.best || {};
    this.history = d.history || [];
    this.settings = { quality: 'high', bloom: true, signalUrl: '', ...(d.settings || {}) };
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ name: this.name, best: this.bestScores, history: this.history.slice(-50), settings: this.settings }));
    } catch {
      /* ignore */
    }
  }

  best(id) {
    return this.bestScores[id] || null;
  }

  record(id, { score, stars, success }) {
    const prev = this.bestScores[id];
    if (!prev || score > prev.score) this.bestScores[id] = { score, stars: Math.max(stars, prev?.stars || 0) };
    else if (stars > prev.stars) prev.stars = stars;
    this.history.push({ id, score, success, at: Date.now() });
    this.save();
  }

  get total() {
    return Object.values(this.bestScores).reduce((s, b) => s + (b.score || 0), 0);
  }

  get totalStars() {
    return Object.values(this.bestScores).reduce((s, b) => s + (b.stars || 0), 0);
  }
}
