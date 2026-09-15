const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room, message) {
  for (const client of room.clients) send(client, message);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create') {
      const code = makeCode();
      const room = { page: 0, paused: false, word: '', clients: new Set() };
      room.clients.add(ws);
      rooms.set(code, room);
      ws.roomCode = code;
      ws.role = msg.role || 'reader';
      send(ws, { type: 'joined', code, role: ws.role, page: room.page, paused: room.paused, word: room.word });
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Сессия не найдена' });
      room.clients.add(ws);
      ws.roomCode = code;
      ws.role = msg.role || 'controller';
      send(ws, { type: 'joined', code, role: ws.role, page: room.page, paused: room.paused, word: room.word });
      broadcast(room, { type: 'presence', count: room.clients.size });
      return;
    }

    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (msg.type === 'control' && ws.role === 'controller') {
      if (msg.action === 'next') room.page += 1;
      if (msg.action === 'prev') room.page = Math.max(0, room.page - 1);
      if (msg.action === 'pause') room.paused = !room.paused;
      if (msg.action === 'page') room.page = Math.max(0, Math.floor(Number(msg.value) || 0));
      if (msg.action === 'word') room.word = String(msg.value || '').slice(0, 100);
      broadcast(room, { type: 'state', page: room.page, paused: room.paused, word: room.word });
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    room.clients.delete(ws);
    if (room.clients.size === 0) rooms.delete(code);
    else broadcast(room, { type: 'presence', count: room.clients.size });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Reader remote listening on port ${PORT}`));
