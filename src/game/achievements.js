// Achievements ("mission patches"). Checked when a flight ends.
const MAIN_MODULES = ['attitude', 'circularize', 'hohmann', 'rendezvous', 'docking', 'debris', 'reentry'];

export const ACHIEVEMENTS = [
  { id: 'first_flight', icon: '🚀', title: 'First Light', desc: 'Complete any training module.', check: (c) => c.success && !c.free },
  { id: 'tumble_tamer', icon: '🌀', title: 'Tumble Tamer', desc: 'Finish Attitude Control in under 90 s.', check: (c) => c.success && c.mission === 'attitude' && c.time < 90 },
  { id: 'penny_pincher', icon: '⛽', title: 'Penny Pincher', desc: 'Hohmann transfer within 1% of the ideal Δv.', check: (c) => c.success && c.mission === 'hohmann' && c.dvUsed <= c.idealDv * 1.01 },
  { id: 'feather_touch', icon: '🪶', title: 'Feather Touch', desc: 'Dock at under 0.08 m/s.', check: (c) => c.contact && c.contact.closing < 0.08 },
  { id: 'bullseye', icon: '🎯', title: 'Bullseye', desc: 'Dock within 5 cm of the port axis.', check: (c) => c.contact && c.contact.lateral < 0.05 },
  { id: 'night_dock', icon: '🌙', title: 'Night Shift', desc: 'Dock while the station is in Earth’s shadow.', check: (c) => c.contact && c.eclipse < 0.5 },
  { id: 'smooth_return', icon: '🪂', title: 'Smooth Return', desc: 'Re-enter with peak load under 3 g.', check: (c) => c.success && c.mission === 'reentry' && c.maxG < 3 },
  { id: 'hot_stuff', icon: '🔥', title: 'Hot Stuff', desc: 'Survive re-entry with less than 25% heat shield left.', check: (c) => c.success && c.mission === 'reentry' && c.shield < 0.25 },
  { id: 'debris_dodger', icon: '☄️', title: 'Debris Dodger', desc: 'Clear a conjunction by more than 3 km.', check: (c) => c.success && c.mission === 'debris' && c.missDistance > 3000 },
  { id: 'close_shave', icon: '😬', title: 'Close Shave', desc: 'Let debris pass within 300 m — and live.', check: (c) => c.mission === 'debris' && c.missDistance < 300 && !c.destroyed },
  { id: 'three_stars', icon: '⭐', title: 'Gold Standard', desc: 'Earn ★★★ on any module.', check: (c) => c.stars >= 3 },
  { id: 'all_modules', icon: '🎓', title: 'Graduate', desc: 'Complete every training module.', check: (c) => MAIN_MODULES.every((m) => c.progress.best(m)) },
  { id: 'full_stars', icon: '🏅', title: 'Ace', desc: '★★★ on every training module.', check: (c) => MAIN_MODULES.every((m) => (c.progress.best(m)?.stars || 0) >= 3) },
  { id: 'daily_pilot', icon: '📅', title: 'Daily Pilot', desc: 'Complete a daily challenge.', check: (c) => c.success && c.daily },
  { id: 'streak3', icon: '🔁', title: 'Regular', desc: 'Fly 3 days in a row.', check: (c) => c.progress.streak.days >= 3 },
  { id: 'streak7', icon: '🗓️', title: 'Devoted', desc: 'Fly 7 days in a row.', check: (c) => c.progress.streak.days >= 7 },
  { id: 'crewmate', icon: '🤝', title: 'Crewmate', desc: 'Complete a multiplayer mission.', check: (c) => c.success && c.multiplayer },
  { id: 'level5', icon: '🎖️', title: 'Seasoned', desc: 'Reach pilot level 5.', check: (c) => c.progress.level >= 5 },
  { id: 'level10', icon: '👑', title: 'Legend', desc: 'Reach pilot level 10.', check: (c) => c.progress.level >= 10 },
];

/** Returns newly unlocked achievements. */
export function checkAchievements(ctx) {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    let ok = false;
    try {
      ok = a.check(ctx);
    } catch {
      ok = false;
    }
    if (ok && ctx.progress.unlock(a.id)) out.push(a);
  }
  return out;
}
