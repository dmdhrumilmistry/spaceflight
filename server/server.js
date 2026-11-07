// Orbital Academy server: serves the built game (dist/) and runs a minimal
// WebSocket signaling relay for WebRTC rooms on /signal.
// Game traffic itself is peer-to-peer over WebRTC data channels.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 8787);
const MAX_ROOM = 8;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!fs.existsSync(DIST)) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('dist/ not found — run `npm run build` first (or use `npm run dev` for development).');
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/** room code -> { host: clientId, members: Map<clientId, ws> } */
const rooms = new Map();
const clients = new Map(); // ws -> { id, name, room }

function code() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  } while (rooms.has(c));
  return c;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const me = { id: null, name: 'Pilot', room: null };
  clients.set(ws, me);
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        me.id = String(msg.id || '').slice(0, 32) || Math.random().toString(36).slice(2, 10);
        me.name = String(msg.name || 'Pilot').slice(0, 24);
        break;
      case 'create': {
        if (!me.id) return;
        const room = code();
        rooms.set(room, { host: me.id, members: new Map([[me.id, ws]]) });
        me.room = room;
        send(ws, { type: 'created', room });
        break;
      }
      case 'join': {
        if (!me.id) return;
        const room = rooms.get(String(msg.room || '').toUpperCase());
        if (!room) return send(ws, { type: 'error', message: 'Room not found' });
        if (room.members.size >= MAX_ROOM) return send(ws, { type: 'error', message: 'Room is full' });
        room.members.set(me.id, ws);
        me.room = msg.room.toUpperCase();
        send(ws, { type: 'joined', room: me.room, hostId: room.host });
        const hostWs = room.members.get(room.host);
        if (hostWs) send(hostWs, { type: 'peer-joined', id: me.id, name: me.name });
        break;
      }
      case 'signal': {
        const room = rooms.get(me.room);
        if (!room) return;
        const target = room.members.get(msg.to);
        if (target) send(target, { type: 'signal', from: me.id, data: msg.data });
        break;
      }
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    const room = rooms.get(me.room);
    if (!room) return;
    room.members.delete(me.id);
    if (room.host === me.id || room.members.size === 0) {
      // host left: notify everyone, close the room (peer links may survive)
      for (const m of room.members.values()) send(m, { type: 'peer-left', id: me.id });
      rooms.delete(me.room);
    } else {
      const hostWs = room.members.get(room.host);
      if (hostWs) send(hostWs, { type: 'peer-left', id: me.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Orbital Academy server on http://localhost:${PORT}  (signaling: ws://localhost:${PORT}/signal)`);
});
