/**
 * Vyntra — server.js
 * 
 * Requires env vars:
 *   MONGO_URI, JWT_SECRET
 *   LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL
 *
 * Install: npm install express ws mongoose bcryptjs jsonwebtoken livekit-server-sdk
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const { AccessToken } = require('livekit-server-sdk');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

/* ── ENV ── */
const MONGO_URI          = process.env.MONGO_URI          || 'mongodb://localhost/vyntra';
const JWT_SECRET         = process.env.JWT_SECRET         || 'changeme';
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LIVEKIT_URL        = process.env.LIVEKIT_URL        || 'wss://your-livekit-instance.livekit.cloud';
const PORT               = process.env.PORT               || 3000;

/* ── MONGOOSE ── */
mongoose.connect(MONGO_URI).then(async () => {
  // Drop stale unique index on msgId if it exists (leftover from old schema)
  try {
    await mongoose.connection.collection('messages').dropIndex('msgId_1');
    console.log('Dropped stale msgId_1 index');
  } catch(e) {
    // Index didn't exist — that's fine
  }
}).catch(console.error);

const userSchema = new mongoose.Schema({
  username:       { type: String, unique: true, required: true },
  email:          { type: String, unique: true, sparse: true },
  password:       { type: String, required: true },
  friends:        [String],
  secretQuestion: { type: String, required: false },
  secretAnswer:   { type: String, required: false },
  verified:       { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const msgSchema = new mongoose.Schema({
  room:      String,
  user:      String,
  text:      String,
  reactions: { type: Map, of: [String], default: {} },
  id:        String,
  createdAt: { type: Date, default: Date.now },
});
const Message = mongoose.model('Message', msgSchema);



/* ── IN-MEMORY STATE ── */
// username → WebSocket
const clients = {};
// roomName → Set<username>
const rooms = {};
// pre-created rooms
const DEFAULT_ROOMS = [
  // General
  'general', 'off-topic', 'introductions', 'announcements',
  // Fun & Social
  'fun', 'memes', 'random', 'daily-chat', 'hot-takes', 'rants',
  // Media
  'tv-shows', 'movies', 'anime', 'books', 'podcasts', 'documentaries',
  // Music
  'music', 'music-recommendations', 'rap', 'lofi', 'rock', 'edm',
  // Gaming
  'gaming', 'minecraft', 'valorant', 'fortnite', 'roblox', 'retro-gaming',
  // Tech
  'dev', 'web-dev', 'ai-ml', 'cybersecurity', 'linux', 'gadgets',
  // Creative
  'art', 'photography', 'writing', 'design', 'video-editing',
  // Lifestyle
  'food', 'fitness', 'travel', 'fashion', 'pets',
  // Serious
  'news', 'science', 'history', 'philosophy', 'finance',
  // Support
  'mental-health', 'study-together', 'job-hunting',
];
DEFAULT_ROOMS.forEach(r => { rooms[r] = new Set(); });

/* ── AUTH ROUTES ── */
app.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password, secretQuestion, secretAnswer } = req.body;
    if (!username || !password || !secretQuestion || !secretAnswer)
      return res.status(400).json({ error: 'All fields required' });
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username already taken' });
    if (email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) return res.status(400).json({ error: 'Email already taken' });
    }
    const hash       = await bcrypt.hash(password, 10);
    const answerHash = await bcrypt.hash(secretAnswer.trim().toLowerCase(), 10);
    const user = await User.create({
      username, email: email || undefined,
      password: hash,
      secretQuestion,
      secretAnswer: answerHash,
    });
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, friends: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'All fields required' });
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ username: user.username, secretQuestion: user.secretQuestion || null });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/verify', async (req, res) => {
  try {
    const { username, secretAnswer } = req.body;
    if (!username || !secretAnswer) return res.status(400).json({ error: 'Missing fields' });
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Wrong answer' });
    // Legacy users without secret question — just let them in
    if (!user.secretAnswer) {
      const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, username: user.username, friends: user.friends });
    }
    const ok = await bcrypt.compare(secretAnswer.trim().toLowerCase(), user.secretAnswer);
    if (!ok) return res.status(401).json({ error: 'Wrong answer' });
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, friends: user.friends });
  } catch (e) {
    console.error('Verify error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});





// Called by the frontend when joining a call/room.
// Returns a short-lived Livekit token for that room.
app.post('/livekit/token', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.status(401).json({ error: 'Unauthorized' }); }

    const { room } = req.body;
    if (!room) return res.status(400).json({ error: 'room required' });

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({ error: 'Livekit not configured' });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: payload.username,
      ttl: '2h',
    });
    at.addGrant({
      roomJoin:       true,
      room:           room,
      canPublish:     true,
      canSubscribe:   true,
      canPublishData: true,
    });

    const lvToken = await at.toJwt();
    res.json({ token: lvToken, url: LIVEKIT_URL });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── WEBSOCKET ── */
function broadcast(room, data, excludeUser) {
  const members = rooms[room];
  if (!members) return;
  const msg = JSON.stringify(data);
  members.forEach(u => {
    if (u === excludeUser) return;
    const ws = clients[u];
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}
function sendTo(username, data) {
  const ws = clients[username];
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcastRoomUsers(room) {
  const members = rooms[room];
  if (!members) return;
  const users = [...members];
  members.forEach(u => sendTo(u, { type: 'users', room, users }));
}

wss.on('connection', ws => {
  let username = null;
  let currentRoom = null;

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }

    /* AUTH */
    if (data.type === 'auth') {
      try {
        const payload = jwt.verify(data.token, JWT_SECRET);
        username = payload.username;
        clients[username] = ws;
        const user = await User.findOne({ username });
        ws.send(JSON.stringify({
          type: 'auth_ok',
          friends: user ? user.friends : [],
        }));
        // Send available rooms
        ws.send(JSON.stringify({ type: 'rooms', rooms: DEFAULT_ROOMS }));
      } catch(e) {
        ws.send(JSON.stringify({ type: 'auth_err' }));
      }
      return;
    }

    if (!username) return;

    /* JOIN ROOM */
    if (data.type === 'join') {
      // Leave old room
      if (currentRoom && rooms[currentRoom]) {
        rooms[currentRoom].delete(username);
        broadcastRoomUsers(currentRoom);
        broadcast(currentRoom, { type: 'system', text: `${username} left` }, username);
      }
      const room = data.room;
      if (!rooms[room]) rooms[room] = new Set();
      rooms[room].add(username);
      currentRoom = room;
      broadcastRoomUsers(room);
      broadcast(room, { type: 'system', text: `${username} joined` }, username);
      // Send recent messages
      const recent = await Message.find({ room }).sort({ createdAt: -1 }).limit(50).lean();
      recent.reverse().forEach(m => {
        const reactions = {};
        if (m.reactions) Object.entries(m.reactions).forEach(([k, v]) => { reactions[k] = v; });
        ws.send(JSON.stringify({ type: 'chat', room, user: m.user, text: m.text, id: m.id, reactions }));
      });
      return;
    }

    /* MESSAGE */
    if (data.type === 'message' && currentRoom) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const msg = await Message.create({ room: currentRoom, user: username, text: data.text, id });
      const out = { type: 'chat', room: currentRoom, user: username, text: data.text, id, reactions: {} };
      rooms[currentRoom].forEach(u => sendTo(u, out));
      return;
    }

    /* REACTION */
    if (data.type === 'reaction') {
      const msg = await Message.findOne({ id: data.messageId });
      if (!msg) return;
      const r = msg.reactions || new Map();
      const arr = r.get(data.emoji) || [];
      const idx = arr.indexOf(username);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(username);
      r.set(data.emoji, arr);
      msg.reactions = r;
      await msg.save();
      const reactions = {};
      r.forEach((v, k) => { reactions[k] = v; });
      if (currentRoom && rooms[currentRoom]) {
        rooms[currentRoom].forEach(u => sendTo(u, { type: 'chat', room: currentRoom, user: msg.user, text: msg.text, id: msg.id, reactions }));
      }
      return;
    }

    /* FRIENDS */
    if (data.type === 'friend_request') {
      const target = await User.findOne({ username: data.to });
      if (!target) return;
      sendTo(data.to, { type: 'friend_request', from: username });
      sendTo(username, { type: 'friend_request_sent', to: data.to });
      return;
    }
    if (data.type === 'friend_accept') {
      const [u1, u2] = [username, data.from];
      await User.updateOne({ username: u1 }, { $addToSet: { friends: u2 } });
      await User.updateOne({ username: u2 }, { $addToSet: { friends: u1 } });
      const me = await User.findOne({ username: u1 });
      const them = await User.findOne({ username: u2 });
      sendTo(u1,  { type: 'friends_update', friends: me.friends });
      sendTo(u2,  { type: 'friends_update', friends: them.friends });
      sendTo(u2,  { type: 'friend_accepted', by: u1 });
      return;
    }
    if (data.type === 'friend_decline') {
      sendTo(data.from, { type: 'friend_declined', by: username });
      return;
    }
    /* ── CALL SIGNALING (Livekit room name exchanged here) ── */
    if (data.type === 'call_request') {
      sendTo(data.to, { type: 'call_incoming', from: username, lvRoom: data.lvRoom, chatRoom: data.chatRoom });
      sendTo(username, { type: 'call_ringing', to: data.to });
      return;
    }
    if (data.type === 'call_accept') {
      sendTo(data.to, { type: 'call_accepted', from: username });
      return;
    }
    if (data.type === 'call_decline') {
      sendTo(data.to, { type: 'call_declined', from: username });
      return;
    }
    if (data.type === 'call_cancel') {
      sendTo(data.to, { type: 'call_ended', from: username });
      return;
    }

    if (data.type === 'unfriend') {
      await User.updateOne({ username }, { $pull: { friends: data.username } });
      await User.updateOne({ username: data.username }, { $pull: { friends: username } });
      const me = await User.findOne({ username });
      sendTo(username, { type: 'friends_update', friends: me.friends });
      sendTo(data.username, { type: 'unfriended', by: username });
      return;
    }
  });

  ws.on('close', () => {
    if (!username) return;
    delete clients[username];
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].delete(username);
      broadcastRoomUsers(currentRoom);
    }
  });
});

server.listen(PORT, () => console.log(`Vyntra running on port ${PORT}`));
