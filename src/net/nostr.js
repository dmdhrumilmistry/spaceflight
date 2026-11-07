// Nostr transport: serverless WebRTC signaling, public room discovery and a
// global leaderboard over public Nostr relays. Loaded lazily (dynamic import)
// so single-player start-up stays fast.
//
// Event kinds used
//  - 25050 (ephemeral)    room signaling: join / offer / answer (offer+answer NIP-44 encrypted)
//  - 30078 (addressable)  app data: public room announcements and best scores
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip44 from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

export const APP = 'orbital-academy-v1';
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.snort.social'];
const KIND_SIGNAL = 25050;
const KIND_APP = 30078;
const ID_KEY = 'orbital-academy-nostr-key';
const now = () => Math.floor(Date.now() / 1000);

/** Persistent pilot identity (for leaderboard); created on first use. */
export function loadIdentity() {
  let hex = null;
  try {
    hex = localStorage.getItem(ID_KEY);
  } catch {
    /* storage unavailable */
  }
  let sk = hex && /^[0-9a-f]{64}$/.test(hex) ? hexToBytes(hex) : null;
  if (!sk) {
    sk = generateSecretKey();
    try {
      localStorage.setItem(ID_KEY, bytesToHex(sk));
    } catch {
      /* ignore */
    }
  }
  return { sk, pk: getPublicKey(sk) };
}

export class NostrBus {
  constructor(relays = DEFAULT_RELAYS) {
    this.relays = relays;
    this.pool = new SimplePool();
  }

  publish(event) {
    return Promise.any(this.pool.publish(this.relays, event)).catch(() => {
      throw new Error('No Nostr relay accepted the event');
    });
  }

  sign(sk, kind, content, tags = []) {
    return finalizeEvent({ kind, created_at: now(), tags, content }, sk);
  }

  subscribe(filter, onevent) {
    const sub = this.pool.subscribeMany(this.relays, filter, {
      onevent: (e) => {
        if (verifyEvent(e)) onevent(e);
      },
    });
    return () => sub.close();
  }

  query(filter, timeoutMs = 4000) {
    return this.pool.querySync(this.relays, filter, { maxWait: timeoutMs });
  }

  close() {
    try {
      this.pool.close(this.relays);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Room signaling. The host listens on the room tag; guests announce themselves
 * with a `join`; the host replies with an encrypted SDP offer (complete ICE,
 * no trickle); the guest answers encrypted. Only these handshakes travel over
 * Nostr — gameplay flows peer-to-peer on WebRTC data channels.
 */
export class NostrSignaling {
  constructor(bus) {
    this.bus = bus;
    this.sk = generateSecretKey(); // ephemeral per session
    this.pk = getPublicKey(this.sk);
    this.unsubs = [];
    this.seen = new Set();
  }

  roomTag(code) {
    return `${APP}:room:${code}`;
  }

  encrypt(toPk, obj) {
    return nip44.v2.encrypt(JSON.stringify(obj), nip44.v2.utils.getConversationKey(this.sk, toPk));
  }

  decrypt(fromPk, text) {
    return JSON.parse(nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(this.sk, fromPk)));
  }

  listen(code, handler) {
    const unsub = this.bus.subscribe({ kinds: [KIND_SIGNAL], '#t': [this.roomTag(code)], since: now() - 20 }, (e) => {
      if (e.pubkey === this.pk || this.seen.has(e.id)) return;
      this.seen.add(e.id);
      const toMe = e.tags.some((t) => t[0] === 'p' && t[1] === this.pk);
      const typeTag = e.tags.find((t) => t[0] === 'type');
      const type = typeTag ? typeTag[1] : '';
      try {
        if (type === 'join') handler({ type, from: e.pubkey, body: JSON.parse(e.content) });
        else if (toMe) handler({ type, from: e.pubkey, body: this.decrypt(e.pubkey, e.content) });
      } catch (err) {
        console.warn('bad signaling event', err);
      }
    });
    this.unsubs.push(unsub);
  }

  send(code, type, body, toPk = null) {
    const tags = [['t', this.roomTag(code)], ['type', type], ['expiration', String(now() + 120)]];
    let content;
    if (toPk) {
      tags.push(['p', toPk]);
      content = this.encrypt(toPk, body);
    } else content = JSON.stringify(body);
    return this.bus.publish(this.bus.sign(this.sk, KIND_SIGNAL, content, tags));
  }

  close() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}

// ---------------------------------------------------------------- lobby
export async function announceRoom(bus, sk, room) {
  const tags = [
    ['d', `${APP}:room`],
    ['t', `${APP}-lobby`],
    ['expiration', String(now() + 150)],
  ];
  return bus.publish(bus.sign(sk, KIND_APP, JSON.stringify(room), tags));
}

export async function listRooms(bus) {
  const events = await bus.query({ kinds: [KIND_APP], '#t': [`${APP}-lobby`], since: now() - 150, limit: 50 });
  const out = [];
  for (const e of events) {
    try {
      const exp = e.tags.find((t) => t[0] === 'expiration');
      if (exp && Number(exp[1]) < now()) continue;
      const r = JSON.parse(e.content);
      if (r && typeof r.room === 'string' && !r.closed) out.push({ ...r, host: e.pubkey, at: e.created_at });
    } catch {
      /* ignore */
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

// ---------------------------------------------------------------- leaderboard
const MAX_PLAUSIBLE = 4000;

export async function publishScore(bus, identity, { board, name, score, stars, mission }) {
  const tags = [
    ['d', `${APP}:score:${board}`],
    ['t', `${APP}-score-${board}`],
    ['mission', mission],
  ];
  const content = JSON.stringify({ name: String(name).slice(0, 20), score: Math.round(score), stars, mission, v: 1 });
  return bus.publish(bus.sign(identity.sk, KIND_APP, content, tags));
}

/** Top scores for a board (mission id or `daily-YYYY-MM-DD`). */
export async function fetchLeaderboard(bus, board, limit = 25) {
  const events = await bus.query({ kinds: [KIND_APP], '#t': [`${APP}-score-${board}`], limit: 300 });
  const best = new Map();
  for (const e of events) {
    try {
      const c = JSON.parse(e.content);
      const score = Number(c.score);
      if (!Number.isFinite(score) || score < 0 || score > MAX_PLAUSIBLE) continue;
      const prev = best.get(e.pubkey);
      if (!prev || score > prev.score) best.set(e.pubkey, { pubkey: e.pubkey, name: String(c.name || 'Pilot').slice(0, 20), score, stars: c.stars | 0, at: e.created_at });
    } catch {
      /* ignore */
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
