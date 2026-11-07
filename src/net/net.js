// WebRTC multiplayer — no game server. Star topology: the room host holds one
// RTCPeerConnection per guest and relays messages. Two data channels per peer:
// "rel" (reliable, ordered: chat, roster, start, results) and "fast"
// (unordered, no retransmit: 10 Hz spacecraft state). The WebRTC handshake is
// exchanged over public Nostr relays (room codes), or by copy/pasting codes.

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
export const PLAYER_COLORS = ['#ffb347', '#7fe8ff', '#ff6fb5', '#9dff6f', '#c79bff', '#ffe66f', '#6fffd2', '#ff8a6f'];

function encode(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}
function decode(code) {
  return JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
}
function randomId() {
  return Math.random().toString(36).slice(2, 10);
}
function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, (x) => A[x % A.length]).join('');
}
const MAX_PLAYERS = 8;

function waitIceComplete(pc, timeout = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeout);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

export class Net {
  constructor({ iceServers = DEFAULT_ICE } = {}) {
    this.iceServers = iceServers;
    this.role = null; // 'host' | 'guest'
    this.mode = null; // 'nostr' | 'manual'
    this.id = randomId();
    this.name = 'Pilot';
    this.color = PLAYER_COLORS[0];
    this.peers = new Map(); // remoteId -> { pc, rel, fast, name }
    this.players = new Map(); // id -> { name, color }
    this.handlers = new Map();
    this.room = null;
    this.hostId = null;
    this.pendingManual = null;
  }

  get active() {
    return this.role !== null && (this.role === 'host' || this.peers.size > 0);
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, ...args) {
    for (const fn of this.handlers.get(type) || []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ------------------------------------------------------------------ Nostr signaling (no server)
  async ensureBus() {
    if (!this.nostrMod) {
      this.nostrMod = await import('./nostr.js');
      this.bus = new this.nostrMod.NostrBus(this.relays || this.nostrMod.DEFAULT_RELAYS);
    }
    return this.nostrMod;
  }

  /** Host a room; the room code is shared with friends (or listed publicly). */
  async hostRoom(name, { isPublic = true, mission = 'free' } = {}) {
    const m = await this.ensureBus();
    this.name = name;
    this.mode = 'nostr';
    this.role = 'host';
    this.hostId = this.id;
    this.room = roomCode();
    this.players.set(this.id, { name: this.name, color: this.color });
    this.signal = new m.NostrSignaling(this.bus);
    this.signal.listen(this.room, (msg) => this.onNostrSignal(msg));
    this.isPublic = isPublic;
    this.lobbyMission = mission;
    if (isPublic) {
      this.announce();
      this.announceTimer = setInterval(() => this.announce(), 60000);
    }
    this.emit('roster', this.roster());
    return this.room;
  }

  announce(closed = false) {
    if (!this.isPublic || !this.signal || this.role !== 'host') return;
    this.nostrMod
      .announceRoom(this.bus, this.signal.sk, {
        room: this.room,
        name: this.name,
        mission: this.lobbyMission,
        players: this.players.size,
        max: MAX_PLAYERS,
        closed,
        v: 1,
      })
      .catch(() => {});
  }

  setLobbyMission(mission) {
    this.lobbyMission = mission;
    this.announce();
  }

  async listPublicRooms() {
    const m = await this.ensureBus();
    return m.listRooms(this.bus);
  }

  // ------------------------------------------------------------------ global leaderboard
  async identity() {
    const m = await this.ensureBus();
    if (!this._identity) this._identity = m.loadIdentity();
    return this._identity;
  }

  async publishScore(entry) {
    const m = await this.ensureBus();
    return m.publishScore(this.bus, await this.identity(), entry);
  }

  async leaderboard(board, limit = 25) {
    const m = await this.ensureBus();
    const rows = await m.fetchLeaderboard(this.bus, board, limit);
    const me = (await this.identity()).pk;
    return rows.map((r) => ({ ...r, me: r.pubkey === me }));
  }

  /** Join a room by code: announce ourselves until the host sends an offer. */
  async joinRoom(code, name) {
    const m = await this.ensureBus();
    this.name = name;
    this.mode = 'nostr';
    this.role = 'guest';
    this.room = code.toUpperCase().trim();
    this.gotOffer = false;
    this.signal = new m.NostrSignaling(this.bus);
    this.signal.listen(this.room, (msg) => this.onNostrSignal(msg));
    const sendJoin = () => this.signal.send(this.room, 'join', { name: this.name, id: this.id }).catch((e) => this.emit('status', e.message));
    await new Promise((r) => setTimeout(r, 900)); // let subscriptions settle
    sendJoin();
    this.emit('status', `Looking for room ${this.room} on Nostr relays…`);
    let tries = 0;
    this.joinTimer = setInterval(() => {
      if (this.gotOffer || this.role !== 'guest') return clearInterval(this.joinTimer);
      if (++tries > 6) {
        clearInterval(this.joinTimer);
        this.emit('status', 'No host answered. Check the room code (rooms close when the host leaves).');
        return;
      }
      sendJoin();
    }, 4000);
    return this.room;
  }

  async onNostrSignal({ type, from, body }) {
    try {
      if (this.role === 'host' && type === 'join') {
        const gid = String(body.id || from).slice(0, 32);
        const existing = this.peers.get(gid);
        if (existing && !['failed', 'closed'].includes(existing.pc.connectionState)) return;
        if (existing) this.dropPeer(gid);
        if (this.players.size >= MAX_PLAYERS) return;
        const peer = this.makePeer(gid, true);
        peer.name = String(body.name || 'Pilot').slice(0, 24);
        peer.nostrPk = from;
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        await waitIceComplete(peer.pc);
        await this.signal.send(this.room, 'offer', { sdp: peer.pc.localDescription, guestId: gid, hostId: this.id }, from);
        this.emit('status', `${peer.name} is connecting…`);
      } else if (this.role === 'guest' && type === 'offer') {
        if (body.guestId !== this.id || this.gotOffer) return;
        this.gotOffer = true;
        this.hostId = body.hostId;
        const peer = this.makePeer(body.hostId, false);
        await peer.pc.setRemoteDescription(body.sdp);
        const ans = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(ans);
        await waitIceComplete(peer.pc);
        await this.signal.send(this.room, 'answer', { sdp: peer.pc.localDescription, guestId: this.id }, from);
        this.emit('status', 'Host found — establishing peer-to-peer link…');
      } else if (this.role === 'host' && type === 'answer') {
        const peer = this.peers.get(body.guestId);
        if (!peer || peer.nostrPk !== from) return;
        if (peer.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription(body.sdp);
      }
    } catch (e) {
      console.warn('signaling error', e);
      this.emit('status', 'Signaling error: ' + e.message);
    }
  }

  // ------------------------------------------------------------------ manual (serverless)
  /** Host: create an invite code for one guest. */
  async createInvite(name) {
    this.name = name;
    this.mode = 'manual';
    if (this.role !== 'host') {
      this.role = 'host';
      this.hostId = this.id;
      this.players.set(this.id, { name: this.name, color: this.color });
      this.emit('roster', this.roster());
    }
    const guestId = randomId();
    const peer = this.makePeer(guestId, true);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    await waitIceComplete(peer.pc);
    this.pendingManual = guestId;
    return encode({ v: 1, host: this.id, guest: guestId, name: this.name, sdp: peer.pc.localDescription });
  }

  /** Guest: paste the host's invite, get an answer code to send back. */
  async acceptInvite(code, name) {
    this.name = name;
    this.mode = 'manual';
    const inv = decode(code);
    this.role = 'guest';
    this.id = inv.guest;
    this.hostId = inv.host;
    const peer = this.makePeer(inv.host, false);
    peer.name = inv.name;
    await peer.pc.setRemoteDescription(inv.sdp);
    const ans = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(ans);
    await waitIceComplete(peer.pc);
    return encode({ v: 1, guest: inv.guest, sdp: peer.pc.localDescription });
  }

  /** Host: paste the guest's answer to complete the connection. */
  async acceptAnswer(code) {
    const ans = decode(code);
    const peer = this.peers.get(ans.guest);
    if (!peer) throw new Error('This answer does not match a pending invite');
    await peer.pc.setRemoteDescription(ans.sdp);
    this.pendingManual = null;
  }

  // ------------------------------------------------------------------ peers
  makePeer(remoteId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { id: remoteId, pc, rel: null, fast: null, name: '?', queued: [] };
    this.peers.set(remoteId, peer);
    const wire = (ch) => {
      ch.onopen = () => this.onChannelOpen(peer, ch);
      // the answering side may receive a channel that is already open
      if (ch.readyState === 'open') queueMicrotask(() => this.onChannelOpen(peer, ch));
      ch.onmessage = (ev) => this.onData(peer, ev.data);
      ch.onclose = () => {
        if (ch.label === 'rel') this.dropPeer(remoteId);
      };
    };
    if (initiator) {
      peer.rel = pc.createDataChannel('rel', { ordered: true });
      peer.fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
      wire(peer.rel);
      wire(peer.fast);
    } else {
      pc.ondatachannel = (ev) => {
        if (ev.channel.label === 'rel') peer.rel = ev.channel;
        else peer.fast = ev.channel;
        wire(ev.channel);
      };
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.emit('status', 'Peer connection failed (NAT?). Try another network or a TURN server.');
        this.dropPeer(remoteId);
      }
    };
    return peer;
  }

  onChannelOpen(peer, ch) {
    if (ch.label !== 'rel') return;
    if (this.role === 'guest') {
      ch.send(JSON.stringify({ t: 'hello', from: this.id, name: this.name }));
      this.emit('status', 'Connected to host');
    }
  }

  dropPeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try {
      p.pc.close();
    } catch {
      /* ignore */
    }
    const info = this.players.get(id);
    this.players.delete(id);
    this.emit('peer-left', id, info);
    if (this.role === 'host') {
      this.broadcast({ t: 'left', id });
      this.broadcastRoster();
    } else if (id === this.hostId) {
      this.emit('status', 'Host disconnected');
      this.emit('host-left');
    }
  }

  roster() {
    return [...this.players.entries()].map(([id, p]) => ({ id, ...p, me: id === this.id, host: id === this.hostId }));
  }

  broadcastRoster() {
    const players = [...this.players.entries()].map(([id, p]) => ({ id, ...p }));
    this.broadcast({ t: 'roster', players, hostId: this.id });
    this.emit('roster', this.roster());
    this.announce();
  }

  // ------------------------------------------------------------------ messaging
  onData(peer, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (this.role === 'host') {
      // authoritative sender id = the peer the message arrived from
      msg.from = peer.id;
      if (msg.t === 'hello') {
        peer.name = String(msg.name || 'Pilot').slice(0, 24);
        const used = new Set([...this.players.values()].map((p) => p.color));
        const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
        this.players.set(peer.id, { name: peer.name, color });
        this.sendTo(peer.id, { t: 'welcome', id: peer.id, color });
        this.broadcastRoster();
        this.emit('joined', peer.id, peer.name);
        return;
      }
      // relay to everyone else
      const ch = msg.t === 'state' ? 'fast' : 'rel';
      for (const [id, p] of this.peers) if (id !== peer.id) this.rawSend(p, ch, msg);
    }
    this.handle(msg);
  }

  handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.color = msg.color;
        break;
      case 'roster':
        this.players = new Map(msg.players.map((p) => [p.id, { name: p.name, color: p.color }]));
        this.hostId = msg.hostId;
        this.emit('roster', this.roster());
        break;
      case 'left':
        this.players.delete(msg.id);
        this.emit('peer-left', msg.id);
        break;
      default:
        this.emit(msg.t, msg, this.players.get(msg.from));
    }
  }

  rawSend(peer, chName, msg) {
    const ch = peer[chName] && peer[chName].readyState === 'open' ? peer[chName] : peer.rel;
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    }
  }

  sendTo(id, msg) {
    const p = this.peers.get(id);
    if (p) this.rawSend(p, 'rel', msg);
  }

  broadcast(msg, ch = 'rel') {
    for (const p of this.peers.values()) this.rawSend(p, ch, msg);
  }

  /** Reliable message to everyone in the room. */
  send(msg) {
    msg.from = this.id;
    this.broadcast(msg, 'rel');
  }

  /** Unreliable, high-rate state update. */
  sendState(msg) {
    msg.from = this.id;
    this.broadcast(msg, 'fast');
  }

  leave() {
    if (this.role === 'host') this.announce(true);
    clearInterval(this.announceTimer);
    clearInterval(this.joinTimer);
    if (this.signal) this.signal.close();
    this.signal = null;
    for (const id of [...this.peers.keys()]) {
      const p = this.peers.get(id);
      try {
        p.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this.players.clear();
    this.role = null;
    this.room = null;
    this.mode = null;
    this.isPublic = false;
  }
}
