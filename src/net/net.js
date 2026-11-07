// WebRTC multiplayer. Star topology: the room host holds one RTCPeerConnection
// per guest and relays messages. Two data channels per peer: "rel" (reliable,
// ordered: chat, roster, start, results) and "fast" (unordered, no retransmit:
// 10 Hz spacecraft state). Signaling via a tiny WebSocket relay server, or a
// serverless copy/paste of SDP codes.

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
    this.mode = null; // 'server' | 'manual'
    this.id = randomId();
    this.name = 'Pilot';
    this.color = PLAYER_COLORS[0];
    this.peers = new Map(); // remoteId -> { pc, rel, fast, name }
    this.players = new Map(); // id -> { name, color }
    this.handlers = new Map();
    this.ws = null;
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

  // ------------------------------------------------------------------ server signaling
  connectServer(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('Signaling server timeout')), 6000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'hello', id: this.id, name: this.name }));
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not reach signaling server'));
      };
      ws.onclose = () => this.emit('status', 'Signaling connection closed');
      ws.onmessage = (ev) => this.onSignal(JSON.parse(ev.data));
    });
  }

  wsSend(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async hostRoom(url, name) {
    this.name = name;
    this.mode = 'server';
    await this.connectServer(url);
    return new Promise((resolve, reject) => {
      this._roomResolve = resolve;
      this._roomReject = reject;
      this.wsSend({ type: 'create' });
    });
  }

  async joinRoom(url, room, name) {
    this.name = name;
    this.mode = 'server';
    await this.connectServer(url);
    return new Promise((resolve, reject) => {
      this._roomResolve = resolve;
      this._roomReject = reject;
      this.wsSend({ type: 'join', room: room.toUpperCase().trim() });
    });
  }

  async onSignal(msg) {
    switch (msg.type) {
      case 'created':
        this.role = 'host';
        this.room = msg.room;
        this.hostId = this.id;
        this.players.set(this.id, { name: this.name, color: this.color });
        this._roomResolve?.(msg.room);
        this.emit('roster', this.roster());
        break;
      case 'joined':
        this.role = 'guest';
        this.room = msg.room;
        this.hostId = msg.hostId;
        this._roomResolve?.(msg.room);
        this.emit('status', `Joined room ${msg.room}, connecting to host…`);
        break;
      case 'error':
        this._roomReject?.(new Error(msg.message));
        this.emit('status', msg.message);
        break;
      case 'peer-joined': {
        // host: start a WebRTC connection to the new guest
        if (this.role !== 'host') break;
        const peer = this.makePeer(msg.id, true);
        peer.name = msg.name;
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this.wsSend({ type: 'signal', to: msg.id, data: { sdp: peer.pc.localDescription } });
        break;
      }
      case 'peer-left':
        this.dropPeer(msg.id);
        break;
      case 'signal': {
        const { from, data } = msg;
        let peer = this.peers.get(from);
        if (!peer) peer = this.makePeer(from, false);
        if (data.sdp) {
          await peer.pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            const ans = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(ans);
            this.wsSend({ type: 'signal', to: from, data: { sdp: peer.pc.localDescription } });
          }
          for (const c of peer.queued || []) await peer.pc.addIceCandidate(c).catch(() => {});
          peer.queued = [];
        } else if (data.candidate) {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
          else (peer.queued ||= []).push(data.candidate);
        }
        break;
      }
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
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.mode === 'server') this.wsSend({ type: 'signal', to: remoteId, data: { candidate: ev.candidate } });
    };
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
    if (this.ws) this.ws.close();
    this.ws = null;
    this.role = null;
    this.room = null;
    this.mode = null;
  }
}
