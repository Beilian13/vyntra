/**
 * Vyntra — server.js
 * Requires env vars: MONGO_URI, JWT_SECRET, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const path       = require('path');
const { AccessToken } = require('livekit-server-sdk');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ── ENV ── */
const MONGO_URI          = process.env.MONGO_URI          || 'mongodb://localhost/vyntra';
const JWT_SECRET         = process.env.JWT_SECRET         || 'changeme';
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LIVEKIT_URL        = process.env.LIVEKIT_URL        || 'wss://your-livekit-instance.livekit.cloud';
const PORT               = process.env.PORT               || 3000;

/* ══════════════════════════════════════════════
   SCHEMAS
══════════════════════════════════════════════ */
const userSchema = new mongoose.Schema({
  username:       { type: String, unique: true, required: true },
  email:          { type: String, unique: true, sparse: true },
  password:       { type: String, required: true },
  friends:        [String],
  secretQuestion: String,
  secretAnswer:   String,
  createdAt:      { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const serverSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  icon:        { type: String, default: '' },
  color:       { type: String, default: '#6c7cff' },
  owner:       { type: String, required: true },
  admins:      [String],
  members:     [String],
  isPublic:    { type: Boolean, default: true },
  isOfficial:  { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now },
});
const VyntraServer = mongoose.model('VyntraServer', serverSchema);

const channelSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  serverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'VyntraServer', required: true },
  createdAt: { type: Date, default: Date.now },
});
const Channel = mongoose.model('Channel', channelSchema);

const msgSchema = new mongoose.Schema({
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel' },
  room:      String,
  user:      String,
  text:      String,
  reactions: { type: Map, of: [String], default: {} },
  id:        String,
  createdAt: { type: Date, default: Date.now },
});
const Message = mongoose.model('Message', msgSchema);

const inviteSchema = new mongoose.Schema({
  token:     { type: String, unique: true, required: true },
  serverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'VyntraServer', required: true },
  createdBy: String,
  used:      { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const Invite = mongoose.model('Invite', inviteSchema);

/* ══════════════════════════════════════════════
   SEED
══════════════════════════════════════════════ */
const DEFAULT_CHANNELS = [
  'general','off-topic','introductions','announcements',
  'fun','memes','random','daily-chat','hot-takes','rants',
  'tv-shows','movies','anime','books','podcasts','documentaries',
  'music','music-recommendations','rap','lofi','rock','edm',
  'gaming','minecraft','valorant','fortnite','roblox','retro-gaming',
  'dev','web-dev','ai-ml','cybersecurity','linux','gadgets',
  'art','photography','writing','design','video-editing',
  'food','fitness','travel','fashion','pets',
  'news','science','history','philosophy','finance',
  'mental-health','study-together','job-hunting',
];

let officialServerId = null;

async function seedOfficialServer() {
  let official = await VyntraServer.findOne({ isOfficial: true });
  if (!official) {
    official = await VyntraServer.create({
      name: 'Vyntra Official', description: 'The official Vyntra community server',
      icon: 'V', color: '#6c7cff', owner: '__system__',
      isPublic: true, isOfficial: true,
    });
    for (const name of DEFAULT_CHANNELS) {
      await Channel.create({ name, serverId: official._id });
    }
    console.log('Seeded official server');
  }
  officialServerId = official._id;
}

mongoose.connect(MONGO_URI).then(async () => {
  try { await mongoose.connection.collection('messages').dropIndex('msgId_1'); } catch(e) {}
  await seedOfficialServer();
}).catch(console.error);

/* ══════════════════════════════════════════════
   AUTH MIDDLEWARE
══════════════════════════════════════════════ */
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Unauthorized' }); }
}

/* ── STATIC / PWA ── */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

/* ══════════════════════════════════════════════
   AUTH ROUTES
══════════════════════════════════════════════ */
app.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password, secretQuestion, secretAnswer } = req.body;
    if (!username || !password || !secretQuestion || !secretAnswer)
      return res.status(400).json({ error: 'All fields required' });
    if (await User.findOne({ username })) return res.status(400).json({ error: 'Username already taken' });
    if (email && await User.findOne({ email })) return res.status(400).json({ error: 'Email already taken' });
    const hash = await bcrypt.hash(password, 10);
    const answerHash = await bcrypt.hash(secretAnswer.trim().toLowerCase(), 10);
    const user = await User.create({ username, email: email||undefined, password: hash, secretQuestion, secretAnswer: answerHash });
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, friends: [] });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'All fields required' });
    const user = await User.findOne({ username });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ username: user.username, secretQuestion: user.secretQuestion || null });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/verify', async (req, res) => {
  try {
    const { username, secretAnswer } = req.body;
    if (!username || !secretAnswer) return res.status(400).json({ error: 'Missing fields' });
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Wrong answer' });
    if (!user.secretAnswer) {
      const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, username: user.username, friends: user.friends });
    }
    if (!await bcrypt.compare(secretAnswer.trim().toLowerCase(), user.secretAnswer))
      return res.status(401).json({ error: 'Wrong answer' });
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, friends: user.friends });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ══════════════════════════════════════════════
   SERVER ROUTES
══════════════════════════════════════════════ */
app.get('/servers', async (req, res) => {
  try {
    const servers = await VyntraServer.find({ isPublic: true }).lean();
    res.json(servers.map(s => ({ ...s, memberCount: (s.members||[]).length })));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/servers/mine', authMiddleware, async (req, res) => {
  try {
    const servers = await VyntraServer.find({
      $or: [{ members: req.user.username }, { owner: req.user.username }, { isOfficial: true }]
    }).lean();
    res.json(servers);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/servers', authMiddleware, async (req, res) => {
  try {
    const { name, description, icon, color, isPublic } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const srv = await VyntraServer.create({
      name, description: description||'', icon: icon||name[0].toUpperCase(),
      color: color||'#6c7cff', owner: req.user.username,
      members: [req.user.username], isPublic: isPublic !== false,
    });
    await Channel.create({ name: 'general', serverId: srv._id });
    const channels = await Channel.find({ serverId: srv._id }).lean();
    res.json({ server: srv, channels });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/servers/:id/channels', async (req, res) => {
  try {
    const channels = await Channel.find({ serverId: req.params.id }).lean();
    res.json(channels);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/servers/:id/channels', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username && !srv.admins.includes(req.user.username))
      return res.status(403).json({ error: 'Forbidden' });
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const ch = await Channel.create({ name: name.toLowerCase().replace(/\s+/g,'-'), serverId: srv._id });
    // Notify all members online
    (srv.members||[]).forEach(m => sendTo(m, { type: 'channel_added', serverId: srv._id.toString(), channel: ch }));
    res.json(ch);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/servers/:id/channels/:cid', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Forbidden' });
    await Channel.deleteOne({ _id: req.params.cid, serverId: srv._id });
    (srv.members||[]).forEach(m => sendTo(m, { type: 'channel_removed', serverId: srv._id.toString(), channelId: req.params.cid }));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/servers/:id/join', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (!srv.isPublic) return res.status(403).json({ error: 'Private — use invite link' });
    await VyntraServer.updateOne({ _id: srv._id }, { $addToSet: { members: req.user.username } });
    const channels = await Channel.find({ serverId: srv._id }).lean();
    res.json({ ok: true, server: srv, channels });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/servers/:id/leave', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.isOfficial) return res.status(400).json({ error: 'Cannot leave official server' });
    if (srv.owner === req.user.username) return res.status(400).json({ error: 'Owner cannot leave' });
    await VyntraServer.updateOne({ _id: srv._id }, { $pull: { members: req.user.username } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/servers/:id', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.isOfficial) return res.status(400).json({ error: 'Cannot delete official server' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Forbidden' });
    await Channel.deleteMany({ serverId: srv._id });
    await VyntraServer.deleteOne({ _id: srv._id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ══════════════════════════════════════════════
   INVITE ROUTES
══════════════════════════════════════════════ */
app.post('/servers/:id/invite', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username && !srv.admins.includes(req.user.username))
      return res.status(403).json({ error: 'Forbidden' });
    const token = crypto.randomBytes(8).toString('hex');
    await Invite.create({ token, serverId: srv._id, createdBy: req.user.username });
    res.json({ token, url: `/invite/${token}` });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/invite/:token', async (req, res) => {
  try {
    const invite = await Invite.findOne({ token: req.params.token, used: false });
    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
    const srv = await VyntraServer.findById(invite.serverId).lean();
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    res.json({ valid: true, server: { ...srv, memberCount: (srv.members||[]).length } });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/invite/:token/accept', authMiddleware, async (req, res) => {
  try {
    const invite = await Invite.findOne({ token: req.params.token, used: false });
    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
    invite.used = true;
    await invite.save();
    await VyntraServer.updateOne({ _id: invite.serverId }, { $addToSet: { members: req.user.username } });
    const srv = await VyntraServer.findById(invite.serverId).lean();
    const channels = await Channel.find({ serverId: invite.serverId }).lean();
    res.json({ ok: true, server: srv, channels });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Serve invite page (SPA handles it)
app.get('/invite/:token', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ══════════════════════════════════════════════
   MESSAGES REST
══════════════════════════════════════════════ */
app.get('/channels/:id/messages', async (req, res) => {
  try {
    const msgs = await Message.find({ channelId: req.params.id }).sort({ createdAt: -1 }).limit(50).lean();
    msgs.reverse();
    res.json(msgs.map(m => {
      const reactions = {};
      if (m.reactions) Object.entries(m.reactions).forEach(([k,v]) => { reactions[k] = v; });
      return { ...m, reactions };
    }));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ══════════════════════════════════════════════
   LIVEKIT TOKEN
══════════════════════════════════════════════ */
app.post('/livekit/token', authMiddleware, async (req, res) => {
  try {
    const { room } = req.body;
    if (!room) return res.status(400).json({ error: 'room required' });
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET)
      return res.status(503).json({ error: 'Livekit not configured' });
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: req.user.username, ttl: '2h' });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ token: await at.toJwt(), url: LIVEKIT_URL });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ══════════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════════ */
const activeChannels = {};
const clients = {};

function sendTo(username, data) {
  const ws = clients[username];
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcastChannel(chanId, data, excludeUser) {
  const members = activeChannels[chanId];
  if (!members) return;
  const msg = JSON.stringify(data);
  members.forEach(u => {
    if (u === excludeUser) return;
    const ws = clients[u];
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}
function broadcastChannelUsers(chanId) {
  const members = activeChannels[chanId];
  if (!members) return;
  const users = [...members];
  members.forEach(u => sendTo(u, { type: 'users', channelId: chanId, users }));
}

wss.on('connection', ws => {
  let username    = null;
  let currentChan = null;

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
        const myServers = await VyntraServer.find({
          $or: [{ members: username }, { owner: username }, { isOfficial: true }]
        }).lean();
        const allChannels = await Channel.find({ serverId: { $in: myServers.map(s=>s._id) } }).lean();
        ws.send(JSON.stringify({
          type: 'auth_ok',
          friends: user ? user.friends : [],
          servers: myServers,
          channels: allChannels,
        }));
      } catch(e) {
        ws.send(JSON.stringify({ type: 'auth_err' }));
      }
      return;
    }

    if (!username) return;

    /* JOIN CHANNEL */
    if (data.type === 'join') {
      if (currentChan && activeChannels[currentChan]) {
        activeChannels[currentChan].delete(username);
        broadcastChannelUsers(currentChan);
        broadcastChannel(currentChan, { type: 'system', text: `${username} left` }, username);
      }
      const chanId = data.channelId || data.room;
      if (!activeChannels[chanId]) activeChannels[chanId] = new Set();
      activeChannels[chanId].add(username);
      currentChan = chanId;
      broadcastChannelUsers(chanId);
      broadcastChannel(chanId, { type: 'system', text: `${username} joined` }, username);
      const query = mongoose.Types.ObjectId.isValid(chanId) ? { channelId: chanId } : { room: chanId };
      const recent = await Message.find(query).sort({ createdAt: -1 }).limit(50).lean();
      recent.reverse().forEach(m => {
        const reactions = {};
        if (m.reactions) Object.entries(m.reactions).forEach(([k,v]) => { reactions[k] = v; });
        ws.send(JSON.stringify({ type: 'chat', channelId: chanId, room: chanId, user: m.user, text: m.text, id: m.id, reactions }));
      });
      return;
    }

    /* MESSAGE */
    if (data.type === 'message' && currentChan) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const isChannel = mongoose.Types.ObjectId.isValid(currentChan);
      await Message.create(isChannel
        ? { channelId: currentChan, user: username, text: data.text, id }
        : { room: currentChan,     user: username, text: data.text, id });
      const out = { type: 'chat', channelId: currentChan, room: currentChan, user: username, text: data.text, id, reactions: {} };
      if (activeChannels[currentChan]) activeChannels[currentChan].forEach(u => sendTo(u, out));
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
      r.forEach((v,k) => { reactions[k] = v; });
      const chanId = msg.channelId ? msg.channelId.toString() : msg.room;
      if (activeChannels[chanId]) activeChannels[chanId].forEach(u => sendTo(u, { type: 'chat', channelId: chanId, room: chanId, user: msg.user, text: msg.text, id: msg.id, reactions }));
      return;
    }

    /* FRIENDS */
    if (data.type === 'friend_request') {
      if (!await User.findOne({ username: data.to })) return;
      sendTo(data.to, { type: 'friend_request', from: username });
      sendTo(username, { type: 'friend_request_sent', to: data.to });
      return;
    }
    if (data.type === 'friend_accept') {
      const [u1,u2] = [username,data.from];
      await User.updateOne({ username: u1 }, { $addToSet: { friends: u2 } });
      await User.updateOne({ username: u2 }, { $addToSet: { friends: u1 } });
      sendTo(u1, { type: 'friends_update', friends: (await User.findOne({username:u1})).friends });
      sendTo(u2, { type: 'friends_update', friends: (await User.findOne({username:u2})).friends });
      sendTo(u2, { type: 'friend_accepted', by: u1 });
      return;
    }
    if (data.type === 'friend_decline') { sendTo(data.from, { type: 'friend_declined', by: username }); return; }
    if (data.type === 'unfriend') {
      await User.updateOne({ username }, { $pull: { friends: data.username } });
      await User.updateOne({ username: data.username }, { $pull: { friends: username } });
      sendTo(username, { type: 'friends_update', friends: (await User.findOne({username})).friends });
      sendTo(data.username, { type: 'unfriended', by: username });
      return;
    }

    /* CALL SIGNALING */
    if (data.type === 'call_request') { sendTo(data.to, { type: 'call_incoming', from: username, lvRoom: data.lvRoom, chatRoom: data.chatRoom }); return; }
    if (data.type === 'call_accept')  { sendTo(data.to, { type: 'call_accepted', from: username }); return; }
    if (data.type === 'call_decline') { sendTo(data.to, { type: 'call_declined', from: username }); return; }
    if (data.type === 'call_cancel')  { sendTo(data.to, { type: 'call_ended',    from: username }); return; }
  });

  ws.on('close', () => {
    if (!username) return;
    delete clients[username];
    if (currentChan && activeChannels[currentChan]) {
      activeChannels[currentChan].delete(username);
      broadcastChannelUsers(currentChan);
    }
  });
});

server.listen(PORT, () => console.log(`Vyntra running on port ${PORT}`));
