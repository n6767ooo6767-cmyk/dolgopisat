const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const Stripe = require('stripe');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/create-checkout', async (req, res) => {
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(503).json({ error: 'VIP-платежи пока не настроены на сервере.' });
  }
  try {
    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/?vip_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?vip_cancelled=1`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось создать оплату.' });
  }
});

app.get('/api/vip-status', async (req, res) => {
  if (!stripe) return res.json({ paid: false });
  const id = String(req.query.session_id || '');
  if (!id) return res.json({ paid: false });
  try {
    const session = await stripe.checkout.sessions.retrieve(id);
    res.json({ paid: session.payment_status === 'paid' });
  } catch {
    res.json({ paid: false });
  }
});

app.post('/api/generate-image', async (req, res) => {
  const { session_id, prompt } = req.body || {};
  if (!stripe || !process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'Генерация пока не настроена на сервере.' });
  }
  if (!session_id || !prompt) return res.status(400).json({ error: 'Нужны session_id и prompt.' });

  try {
    const session = await stripe.checkout.sessions.retrieve(String(session_id));
    if (session.payment_status !== 'paid') return res.status(403).json({ error: 'VIP ещё не активирован.' });

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
        prompt: String(prompt).slice(0, 1000),
        size: '1024x1024'
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: 'Не удалось создать картинку.' });

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: 'Сервер не получил картинку.' });
    res.json({ image: `data:image/png;base64,${b64}` });
  } catch {
    res.status(500).json({ error: 'Ошибка генерации.' });
  }
});

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