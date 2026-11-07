// Persistent pilot profile (localStorage): best scores, stars, XP & level,
// achievements, daily-challenge results, play streak and settings.
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

export function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function levelForXp(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 300)) + 1;
}
export function xpForLevel(level) {
  return 300 * (level - 1) * (level - 1);
}

const isMobile = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));

export class Progress {
  constructor() {
    const d = load() || {};
    this.name = d.name || `Pilot-${Math.floor(100 + Math.random() * 900)}`;
    this.bestScores = d.best || {};
    this.history = d.history || [];
    this.xp = d.xp || 0;
    this.achievements = d.achievements || {};
    this.daily = d.daily || {};
    this.streak = d.streak || { last: null, days: 0, best: 0 };
    this.flights = d.flights || 0;
    this.settings = {
      quality: isMobile() ? 'medium' : 'high',
      bloom: true,
      master: 0.8,
      music: 0.6,
      sfx: 0.8,
      muted: false,
      shareScores: true,
      touch: 'auto',
      relays: '',
      ...(d.settings || {}),
    };
  }

  save() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          name: this.name,
          best: this.bestScores,
          history: this.history.slice(-60),
          xp: this.xp,
          achievements: this.achievements,
          daily: this.daily,
          streak: this.streak,
          flights: this.flights,
          settings: this.settings,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  get level() {
    return levelForXp(this.xp);
  }

  best(id) {
    return this.bestScores[id] || null;
  }

  /** Record a finished flight. Returns { xpGained, levelUp, improved }. */
  record(id, { score, stars, success, daily = null }) {
    const prev = this.bestScores[id];
    let improved = false;
    if (success && (!prev || score > prev.score)) {
      this.bestScores[id] = { score, stars: Math.max(stars, prev?.stars || 0) };
      improved = true;
    } else if (prev && stars > prev.stars) prev.stars = stars;
    if (daily && success) {
      const d = this.daily[daily] || { best: 0 };
      if (score > d.best) d.best = score;
      d.done = true;
      this.daily[daily] = d;
    }
    this.history.push({ id, score, success, at: Date.now() });
    this.flights++;
    // XP: flying always pays a little; success pays the score
    const before = this.level;
    const xpGained = Math.round(40 + (success ? score : score * 0.5) + (daily && success ? 250 : 0));
    this.xp += xpGained;
    this.touchStreak();
    this.save();
    return { xpGained, levelUp: this.level > before ? this.level : 0, improved };
  }

  touchStreak() {
    const today = dayKey();
    if (this.streak.last === today) return;
    const y = new Date();
    y.setUTCDate(y.getUTCDate() - 1);
    this.streak.days = this.streak.last === dayKey(y) ? this.streak.days + 1 : 1;
    this.streak.best = Math.max(this.streak.best || 0, this.streak.days);
    this.streak.last = today;
  }

  unlock(id) {
    if (this.achievements[id]) return false;
    this.achievements[id] = Date.now();
    this.xp += 150;
    this.save();
    return true;
  }

  get total() {
    return Object.values(this.bestScores).reduce((s, b) => s + (b.score || 0), 0);
  }

  get totalStars() {
    return Object.values(this.bestScores).reduce((s, b) => s + (b.stars || 0), 0);
  }
}
