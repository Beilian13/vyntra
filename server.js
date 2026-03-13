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
const multer     = require('multer');
const { AccessToken } = require('livekit-server-sdk');
const webpush    = require('web-push');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// node-fetch fallback for environments without native fetch
let _fetch = typeof fetch !== 'undefined' ? fetch : null;
(async () => {
  if (!_fetch) {
    try { const nf = await import('node-fetch'); _fetch = nf.default; } catch(e) {}
  }
})();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ── CLOUDINARY UPLOAD ── */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const cloudStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.startsWith('video/');
    const isAudio = file.mimetype.startsWith('audio/');
    const isRaw   = file.mimetype === 'application/pdf' || file.mimetype === 'text/plain';
    return {
      folder:        'vyntra',
      resource_type: isVideo ? 'video' : isAudio ? 'video' : isRaw ? 'raw' : 'image',
      // Cloudinary uses 'video' resource_type for audio too
      public_id:     `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      allowed_formats: ['jpg','jpeg','png','gif','webp','mp4','webm','mov','mp3','ogg','wav','aac','flac','m4a','pdf','txt'],
    };
  },
});
const upload = multer({
  storage: cloudStorage,
  limits: { fileSize: 32 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac|x-m4a)|application\/pdf|text\/plain/.test(file.mimetype);
    cb(null, ok);
  },
});

/* ── ENV ── */
const MONGO_URI          = process.env.MONGO_URI          || 'mongodb://localhost/vyntra';
const JWT_SECRET         = process.env.JWT_SECRET         || 'changeme';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LIVEKIT_URL        = process.env.LIVEKIT_URL        || 'wss://your-livekit-instance.livekit.cloud';
const PORT               = process.env.PORT               || 3000;
const ADMIN_USER         = process.env.ADMIN_USER         || 'benrrava';
const ADMIN_EMAIL        = process.env.ADMIN_EMAIL        || 'beilian.alvarenga@gmail.com';
const VAPID_PUBLIC_KEY   = process.env.VAPID_PUBLIC_KEY   || '';
const VAPID_PRIVATE_KEY  = process.env.VAPID_PRIVATE_KEY  || '';
const VAPID_EMAIL        = process.env.VAPID_EMAIL        || 'mailto:admin@vyntra.app';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/* ══════════════════════════════════════════════
   SCHEMAS
══════════════════════════════════════════════ */
const userSchema = new mongoose.Schema({
  username:        { type: String, unique: true, required: true },
  email:           { type: String, unique: true, sparse: true },
  password:        { type: String, required: true },
  friends:         [String],
  blockedUsers:    [String],
  pendingFriends:  [String],
  secretQuestion:  String,
  secretAnswer:    String,
  // Profile
  bio:             { type: String, default: '' },
  pronouns:        { type: String, default: '' },
  statusEmoji:     { type: String, default: '' },
  statusText:      { type: String, default: '' },
  bannerColor:     { type: String, default: '#6c7cff' },
  avatarUrl:       { type: String, default: '' },
  // Customization (saved server-side so it roams across devices)
  customCss:       { type: String, default: '' },
  injectHtml:      { type: String, default: '' },
  createdAt:       { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const roleSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  color:       { type: String, default: '#6c7cff' },
  permissions: { type: [String], default: [] }, // 'send_messages','manage_channels','manage_roles','kick_members','ban_members','manage_server'
}, { _id: true });

const serverSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  icon:        { type: String, default: '' },
  color:       { type: String, default: '#6c7cff' },
  owner:       { type: String, required: true },
  admins:      [String],
  members:     [String],
  roles:       { type: [roleSchema], default: [] },
  memberRoles: { type: Map, of: [String], default: {} }, // username → [roleId]
  isPublic:    { type: Boolean, default: true },
  isOfficial:  { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now },
});
const VyntraServer = mongoose.model('VyntraServer', serverSchema);

const channelSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  type:      { type: String, default: 'text' }, // 'text' | 'announcement'
  category:  { type: String, default: 'Text Channels' },
  position:  { type: Number, default: 0 },
  serverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'VyntraServer', required: true },
  createdAt: { type: Date, default: Date.now },
});
const Channel = mongoose.model('Channel', channelSchema);

const msgSchema = new mongoose.Schema({
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel' },
  room:      String,
  user:      String,
  text:      String,
  fileUrl:   String,
  fileName:  String,
  fileType:  String,
  reactions: { type: Map, of: [String], default: {} },
  replyTo:   { type: Object, default: null }, // {id, user, text}
  id:        String,
  editedAt:  { type: Date, default: null },
  seenBy:    { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});
msgSchema.add({ threadCount: { type: Number, default: 0 } });
const Message = mongoose.model('Message', msgSchema);

/* ── Thread replies — each reply belongs to a parent message ── */
const threadReplySchema = new mongoose.Schema({
  parentId:  { type: String, required: true, index: true }, // parent message id
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel' },
  room:      String,
  user:      String,
  text:      String,
  fileUrl:   String,
  fileName:  String,
  fileType:  String,
  reactions: { type: Map, of: [String], default: {} },
  id:        String,
  editedAt:  { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
threadReplySchema.index({ parentId: 1, createdAt: 1 });
const ThreadReply = mongoose.model('ThreadReply', threadReplySchema);

const inviteSchema = new mongoose.Schema({
  token:     { type: String, unique: true, required: true },
  serverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'VyntraServer', required: true },
  createdBy: String,
  used:      { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const Invite = mongoose.model('Invite', inviteSchema);

/* ══════════════════════════════════════════════
   DB MODEL — PushSubscription
══════════════════════════════════════════════ */
const pushSubSchema = new mongoose.Schema({
  username:     { type: String, required: true },
  subscription: { type: Object, required: true },
  createdAt:    { type: Date, default: Date.now },
});
pushSubSchema.index({ username: 1 });
const PushSub = mongoose.model('PushSub', pushSubSchema);

const reportSchema = new mongoose.Schema({
  reporter:  { type: String, required: true },
  reported:  { type: String, required: true },
  reason:    { type: String, default: '' },
  messageId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  reviewed:  { type: Boolean, default: false },
});
const Report = mongoose.model('Report', reportSchema);

const stickerSchema = new mongoose.Schema({
  serverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'VyntraServer', required: true },
  name:      { type: String, required: true },
  url:       { type: String, required: true },
  uploadedBy:{ type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Sticker = mongoose.model('Sticker', stickerSchema);

const customEmojiSchema = new mongoose.Schema({
  serverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'VyntraServer', required: true },
  name:      { type: String, required: true },   // :name: shortcode
  url:       { type: String, required: true },
  uploadedBy:{ type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const CustomEmoji = mongoose.model('CustomEmoji', customEmojiSchema);

async function pushToUser(username, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = await PushSub.find({ username }).lean();
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await PushSub.deleteOne({ _id: sub._id });
      }
    }
  }
}

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
  try {
    await mongoose.connection.collection('messages').createIndex({ channelId: 1, createdAt: -1 });
    await mongoose.connection.collection('messages').createIndex({ room: 1, createdAt: -1 });
  } catch(e) {}
  // Seed announcement channel cache
  const annChans = await Channel.find({ type: 'announcement' }).lean();
  annChans.forEach(c => announcementChannels.add(c._id.toString()));
  await seedOfficialServer();
}).catch(console.error);

/* ── MESSAGE WRITE BUFFER ──
   Batches rapid message writes to reduce Mongo round-trips.
   Flushes every 200ms or when buffer hits 20 messages.          */
const msgBuffer = [];
let msgFlushTimer = null;
function bufferMessage(doc) {
  msgBuffer.push(doc);
  if (msgBuffer.length >= 20) flushMessages();
  else if (!msgFlushTimer) msgFlushTimer = setTimeout(flushMessages, 200);
}
async function flushMessages() {
  clearTimeout(msgFlushTimer); msgFlushTimer = null;
  if (!msgBuffer.length) return;
  const batch = msgBuffer.splice(0, msgBuffer.length);
  try { await mongoose.connection.collection('messages').insertMany(batch, { ordered: false }); }
  catch(e) { console.error('Message flush error:', e.message); }
}

/* ══════════════════════════════════════════════
   AUTH MIDDLEWARE
══════════════════════════════════════════════ */
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, async function() {
    try {
      if (req.user.username !== ADMIN_USER) return res.status(403).json({ error: 'Forbidden' });
      // Double-check: verify email matches in DB — prevents impersonation via username alone
      const u = await User.findOne({ username: ADMIN_USER }).lean();
      if (!u || (u.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase())
        return res.status(403).json({ error: 'Forbidden' });
      next();
    } catch(e) { res.status(500).json({ error: 'Server error' }); }
  });
}

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Unauthorized' }); }
}

/* ── STATIC / PWA ── */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));

/* ── ADMIN ROUTES (benrrava only) ── */

// List all users
app.get('/admin/users', adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({}, 'username email createdAt friends').sort({ createdAt: -1 }).lean();
    const online = Object.keys(clients);
    res.json(users.map(u => ({ ...u, online: online.includes(u.username) })));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Delete a user account + clean up all their data
app.delete('/admin/users/:username', adminMiddleware, async (req, res) => {
  try {
    const target = req.params.username;
    // Protect the real admin account (must match both username AND email)
    const targetUser = await User.findOne({ username: target }).lean();
    if (target === ADMIN_USER && targetUser && (targetUser.email||'').toLowerCase() === ADMIN_EMAIL.toLowerCase())
      return res.status(400).json({ error: 'Cannot delete the admin account' });
    // Force disconnect WS
    if (clients[target]) {
      try { clients[target].close(); } catch(e) {}
    }
    // Remove from all friends lists
    await User.updateMany({ friends: target }, { $pull: { friends: target } });
    // Transfer owned servers to nobody (delete them) or just remove member
    const ownedServers = await VyntraServer.find({ owner: target }).lean();
    for (const srv of ownedServers) {
      await Channel.deleteMany({ serverId: srv._id });
      await Message.deleteMany({ channelId: { $in: (await Channel.find({ serverId: srv._id }).lean()).map(c => c._id) } });
      await VyntraServer.deleteOne({ _id: srv._id });
    }
    // Remove from member/admin lists on other servers
    await VyntraServer.updateMany({}, { $pull: { members: target, admins: target } });
    // Delete their messages (optional — keeps chat history by default, just deletes account)
    // await Message.deleteMany({ user: target });
    // Delete their push subs
    await PushSub.deleteMany({ username: target });
    // Delete user
    await User.deleteOne({ username: target });
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Force-kick (disconnect WS session without deleting account)
app.post('/admin/users/:username/kick', adminMiddleware, async (req, res) => {
  try {
    const target = req.params.username;
    if (clients[target]) {
      sendTo(target, { type: 'system', text: '🚫 You have been disconnected by an admin.' });
      setTimeout(() => { try { clients[target].close(); } catch(e) {} }, 300);
    }
    res.json({ ok: true, wasOnline: target in clients });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Reset a user's password
app.post('/admin/users/:username/reset-password', adminMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password too short' });
    const hash = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ username: req.params.username }, { password: hash, secretAnswer: null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Get user details
app.get('/admin/users/:username', adminMiddleware, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username }, '-password').lean();
    if (!u) return res.status(404).json({ error: 'Not found' });
    const servers = await VyntraServer.find({ $or: [{ owner: u.username }, { members: u.username }] }, 'name owner isOfficial').lean();
    const msgCount = await Message.countDocuments({ user: u.username });
    res.json({ ...u, servers, msgCount, online: u.username in clients });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ── BLOCK / REPORT ── */
app.post('/users/:username/block', authMiddleware, async (req, res) => {
  try {
    const target = req.params.username;
    if (target === req.user.username) return res.status(400).json({ error: 'Cannot block yourself' });
    await User.updateOne({ username: req.user.username }, { $addToSet: { blockedUsers: target }, $pull: { friends: target, pendingFriends: target } });
    await User.updateOne({ username: target }, { $pull: { friends: req.user.username } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/users/:username/unblock', authMiddleware, async (req, res) => {
  try {
    await User.updateOne({ username: req.user.username }, { $pull: { blockedUsers: req.params.username } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/users/:username/report', authMiddleware, async (req, res) => {
  try {
    const { reason, messageId } = req.body;
    await Report.create({ reporter: req.user.username, reported: req.params.username, reason: reason||'', messageId: messageId||null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
// Admin: list reports
app.get('/admin/reports', adminMiddleware, async (req, res) => {
  try {
    const reports = await Report.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(reports);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/admin/reports/:id/review', adminMiddleware, async (req, res) => {
  try {
    await Report.updateOne({ _id: req.params.id }, { reviewed: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});


/* ── USER PROFILE ── */
app.get('/profile/:username', async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username }, '-password -secretAnswer -blockedUsers -pendingFriends -customCss -injectHtml').lean();
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json(u);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.patch('/profile', authMiddleware, async (req, res) => {
  try {
    const { bio, pronouns, statusEmoji, statusText, bannerColor, avatarUrl } = req.body;
    const update = {};
    if (bio         !== undefined) update.bio         = bio.slice(0, 300);
    if (pronouns    !== undefined) update.pronouns    = pronouns.slice(0, 40);
    if (statusEmoji !== undefined) update.statusEmoji = statusEmoji.slice(0, 8);
    if (statusText  !== undefined) update.statusText  = statusText.slice(0, 80);
    if (bannerColor !== undefined) update.bannerColor = bannerColor;
    if (avatarUrl   !== undefined) update.avatarUrl   = avatarUrl;
    await User.updateOne({ username: req.user.username }, update);
    const updated = await User.findOne({ username: req.user.username }, '-password -secretAnswer').lean();
    // Broadcast status change to online users
    broadcastAll({ type: 'status_update', username: req.user.username, statusEmoji: updated.statusEmoji, statusText: updated.statusText, avatarUrl: updated.avatarUrl });
    res.json({ ok: true, profile: updated });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
// Save custom CSS/HTML (private — only returned to the owner)
app.patch('/profile/customization', authMiddleware, async (req, res) => {
  try {
    const { customCss, injectHtml } = req.body;
    const update = {};
    if (customCss   !== undefined) update.customCss   = customCss.slice(0, 50000);
    if (injectHtml  !== undefined) update.injectHtml  = injectHtml.slice(0, 50000);
    await User.updateOne({ username: req.user.username }, update);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.get('/profile/customization/me', authMiddleware, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.user.username }, 'customCss injectHtml').lean();
    res.json({ customCss: u?.customCss||'', injectHtml: u?.injectHtml||'' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ── STICKERS ── */
// List stickers for a server
app.get('/servers/:id/stickers', authMiddleware, async (req, res) => {
  try {
    const stickers = await Sticker.find({ serverId: req.params.id }).lean();
    res.json(stickers);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
// Upload sticker (image only, stored on Cloudinary)
app.post('/servers/:id/stickers', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username && !srv.admins.includes(req.user.username))
      return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const sticker = await Sticker.create({ serverId: srv._id, name: name.slice(0,32), url: req.file.path, uploadedBy: req.user.username });
    broadcastToServer(srv, { type: 'sticker_added', serverId: srv._id.toString(), sticker });
    res.json(sticker);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.delete('/servers/:id/stickers/:sid', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv || (srv.owner !== req.user.username && !srv.admins.includes(req.user.username)))
      return res.status(403).json({ error: 'Forbidden' });
    await Sticker.deleteOne({ _id: req.params.sid, serverId: srv._id });
    broadcastToServer(srv, { type: 'sticker_removed', serverId: srv._id.toString(), stickerId: req.params.sid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ── CUSTOM EMOJI ── */
app.get('/servers/:id/emoji', authMiddleware, async (req, res) => {
  try {
    const emoji = await CustomEmoji.find({ serverId: req.params.id }).lean();
    res.json(emoji);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/servers/:id/emoji', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username && !srv.admins.includes(req.user.username))
      return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    let { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    name = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
    // Check for duplicates within this server
    const exists = await CustomEmoji.findOne({ serverId: srv._id, name });
    if (exists) return res.status(400).json({ error: 'Emoji name already exists on this server' });
    const emoji = await CustomEmoji.create({ serverId: srv._id, name, url: req.file.path, uploadedBy: req.user.username });
    broadcastToServer(srv, { type: 'emoji_added', serverId: srv._id.toString(), emoji });
    res.json(emoji);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.delete('/servers/:id/emoji/:eid', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv || (srv.owner !== req.user.username && !srv.admins.includes(req.user.username)))
      return res.status(403).json({ error: 'Forbidden' });
    await CustomEmoji.deleteOne({ _id: req.params.eid, serverId: srv._id });
    broadcastToServer(srv, { type: 'emoji_removed', serverId: srv._id.toString(), emojiId: req.params.eid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ── SERVER ROLES ── */
app.get('/servers/:id/roles', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id).lean();
    if (!srv) return res.status(404).json({ error: 'Not found' });
    res.json({ roles: srv.roles||[], memberRoles: Object.fromEntries(srv.memberRoles||new Map()) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/servers/:id/roles', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Forbidden' });
    const { name, color, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    srv.roles.push({ name, color: color||'#6c7cff', permissions: permissions||[] });
    await srv.save();
    const role = srv.roles[srv.roles.length-1];
    broadcastToServer(srv, { type: 'roles_updated', serverId: srv._id.toString(), roles: srv.roles });
    res.json(role);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.delete('/servers/:id/roles/:roleId', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv || srv.owner !== req.user.username) return res.status(403).json({ error: 'Forbidden' });
    srv.roles = srv.roles.filter(r => r._id.toString() !== req.params.roleId);
    await srv.save();
    broadcastToServer(srv, { type: 'roles_updated', serverId: srv._id.toString(), roles: srv.roles });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/servers/:id/members/:username/roles', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username && !srv.admins.includes(req.user.username)) return res.status(403).json({ error: 'Forbidden' });
    const { roleIds } = req.body; // array of role IDs
    srv.memberRoles.set(req.params.username, roleIds||[]);
    await srv.save();
    broadcastToServer(srv, { type: 'member_roles_updated', serverId: srv._id.toString(), username: req.params.username, roleIds: roleIds||[] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ── CHANNEL CATEGORY ── */
app.patch('/servers/:id/channels/:cid/category', authMiddleware, async (req, res) => {
  try {
    const srv = await VyntraServer.findById(req.params.id);
    if (!srv) return res.status(404).json({ error: 'Not found' });
    if (srv.owner !== req.user.username && !srv.admins.includes(req.user.username)) return res.status(403).json({ error: 'Forbidden' });
    const { category } = req.body;
    await Channel.updateOne({ _id: req.params.cid, serverId: srv._id }, { category: category||'Text Channels' });
    const allChannels = await Channel.find({ serverId: srv._id }).lean();
    broadcastToServer(srv, { type: 'channels_updated', serverId: srv._id.toString(), channels: allChannels });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ── AI PROXY ── */
app.post('/ai/chat', authMiddleware, async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) return res.status(503).json({ error: 'AI not configured — set OPENROUTER_API_KEY in Render env vars' });
    if (!_fetch) return res.status(503).json({ error: 'fetch not available on this server' });
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid messages array' });

    const makeRequest = async (model) => {
      return _fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer':  'https://vyntra-zlfn.onrender.com',
          'X-Title':       'Vyntra',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1000,
          messages: [
            { role: 'system', content: system || 'You are Vyntra AI, a helpful assistant embedded in a chat app. Be concise and friendly.' },
            ...messages.slice(-10),
          ],
        }),
      });
    };

    let response = await makeRequest('deepseek/deepseek-chat-v3-0324:free');
    let data = await response.json();

    // If primary model fails, fall back to openrouter/free auto-router
    if (!response.ok || data?.error) {
      console.warn('Primary AI model failed, trying fallback:', data?.error?.message);
      response = await makeRequest('openrouter/auto');
      data = await response.json();
    }

    if (!response.ok) {
      console.error('OpenRouter API error:', response.status, JSON.stringify(data));
      return res.status(500).json({ error: data?.error?.message || `OpenRouter returned ${response.status}` });
    }
    const text = data.choices?.[0]?.message?.content || '(no response)';
    res.json({ text });
  } catch (e) {
    console.error('AI proxy exception:', e);
    res.status(500).json({ error: e.message || 'AI request failed' });
  }
});

/* ── PUSH NOTIFICATIONS ── */
app.get('/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});
app.post('/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid' });
    await PushSub.findOneAndUpdate(
      { username: req.user.username, 'subscription.endpoint': subscription.endpoint },
      { username: req.user.username, subscription, createdAt: new Date() },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/push/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) await PushSub.deleteMany({ username: req.user.username, 'subscription.endpoint': endpoint });
    else await PushSub.deleteMany({ username: req.user.username });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ── FILE UPLOAD ── */
app.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url:      req.file.path,          // Cloudinary CDN URL (permanent)
    fileName: req.file.originalname,
    fileType: req.file.mimetype,
  });
});
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
    const { name, type, category } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const chType = ['text','announcement'].includes(type) ? type : 'text';
    const chCategory = category || 'Text Channels';
    const ch = await Channel.create({ name: name.toLowerCase().replace(/\s+/g,'-'), type: chType, category: chCategory, serverId: srv._id });
    if (chType === 'announcement') announcementChannels.add(ch._id.toString());
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

/* ── MESSAGE SEARCH ── */
app.get('/channels/:id/search', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const msgs = await Message.find({
      channelId: req.params.id,
      text: { $regex: q, $options: 'i' }
    }).sort({ createdAt: -1 }).limit(40).lean();
    res.json(msgs.map(m => {
      const reactions = {};
      if (m.reactions) Object.entries(m.reactions).forEach(([k,v]) => { reactions[k] = v; });
      return { ...m, reactions };
    }));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* ══════════════════════════════════════════════
   THREADS
══════════════════════════════════════════════ */
/* GET replies for a parent message */
app.get('/threads/:parentId', authMiddleware, async (req, res) => {
  try {
    const replies = await ThreadReply.find({ parentId: req.params.parentId })
      .sort({ createdAt: 1 }).limit(200).lean();
    res.json(replies.map(r => {
      const reactions = {};
      if (r.reactions) Object.entries(r.reactions).forEach(([k,v]) => { reactions[k] = v; });
      return { ...r, reactions };
    }));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

/* POST a new thread reply */
app.post('/threads/:parentId', authMiddleware, async (req, res) => {
  try {
    const { text, fileUrl, fileName, fileType, channelId, room } = req.body;
    if (!text && !fileUrl) return res.status(400).json({ error: 'Empty reply' });
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const reply = await ThreadReply.create({
      parentId: req.params.parentId, channelId, room,
      user: req.user.username, text, fileUrl, fileName, fileType,
      id, reactions: {}, createdAt: new Date(),
    });
    // Increment parent threadCount
    await Message.updateOne({ id: req.params.parentId }, { $inc: { threadCount: 1 } });
    const out = { type: 'thread_reply', parentId: req.params.parentId, reply: { ...reply.toObject(), reactions: {} } };
    // Broadcast to all channel members
    if (channelId) {
      const members = activeChannels[channelId.toString()] || new Set();
      members.forEach(u => sendTo(u, out));
    }
    res.json({ ok: true, reply: { ...reply.toObject(), reactions: {} } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* DELETE a thread reply */
app.delete('/threads/reply/:replyId', authMiddleware, async (req, res) => {
  try {
    const reply = await ThreadReply.findOne({ id: req.params.replyId });
    if (!reply) return res.status(404).json({ error: 'Not found' });
    if (reply.user !== req.user.username) return res.status(403).json({ error: 'Not yours' });
    await ThreadReply.deleteOne({ id: req.params.replyId });
    await Message.updateOne({ id: reply.parentId }, { $inc: { threadCount: -1 } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* PATCH edit a thread reply */
app.patch('/threads/reply/:replyId', authMiddleware, async (req, res) => {
  try {
    const reply = await ThreadReply.findOne({ id: req.params.replyId });
    if (!reply) return res.status(404).json({ error: 'Not found' });
    if (reply.user !== req.user.username) return res.status(403).json({ error: 'Not yours' });
    reply.text = req.body.text || reply.text;
    reply.editedAt = new Date();
    await reply.save();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* POST react to a thread reply */
app.post('/threads/reply/:replyId/react', authMiddleware, async (req, res) => {
  try {
    const { emoji } = req.body;
    const reply = await ThreadReply.findOne({ id: req.params.replyId });
    if (!reply) return res.status(404).json({ error: 'Not found' });
    const users = reply.reactions.get(emoji) || [];
    const idx = users.indexOf(req.user.username);
    if (idx >= 0) users.splice(idx, 1); else users.push(req.user.username);
    reply.reactions.set(emoji, users);
    await reply.save();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


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
const typingTimers = {};
const announcementChannels = new Set();
// In-memory call rooms: lvRoom → { members: Set, polls: Map<pollId, poll> }
const callRooms = {};
function ensureCallRoom(room) {
  if (!callRooms[room]) callRooms[room] = { members: new Set(), polls: new Map() };
  return callRooms[room];
}

function broadcastToServer(srv, data) {
  const members = [...new Set([srv.owner, ...(srv.admins||[]), ...(srv.members||[])])];
  members.forEach(m => sendTo(m, data));
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  Object.values(clients).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

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
        const blockedUsers = user ? (user.blockedUsers||[]) : [];
        const pendingFriends = user ? (user.pendingFriends||[]) : [];
        const myServers = await VyntraServer.find({
          $or: [{ members: username }, { owner: username }, { isOfficial: true }]
        }).lean();
        const allChannels = await Channel.find({ serverId: { $in: myServers.map(s=>s._id) } }).lean();
        const isAdmin = (
          username === ADMIN_USER &&
          user && (user.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase()
        );
        ws.send(JSON.stringify({
          type: 'auth_ok',
          friends: user ? user.friends : [],
          blockedUsers,
          pendingFriends,
          profile: user ? { bio: user.bio, pronouns: user.pronouns, statusEmoji: user.statusEmoji, statusText: user.statusText, bannerColor: user.bannerColor, avatarUrl: user.avatarUrl } : {},
          servers: myServers,
          channels: allChannels,
          onlineUsers: Object.keys(clients),
          isAdmin,
        }));
        broadcastAll({ type: 'online_users', users: Object.keys(clients) });
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
        ws.send(JSON.stringify({ type: 'chat', channelId: chanId, room: chanId, user: m.user, text: m.text, fileUrl: m.fileUrl, fileName: m.fileName, fileType: m.fileType, replyTo: m.replyTo||null, id: m.id, reactions, seenBy: m.seenBy||[] }));
      });
      return;
    }

    /* MESSAGE */
    if (data.type === 'message' && currentChan) {
      if (announcementChannels.has(currentChan)) {
        const ch = await Channel.findById(currentChan).lean();
        if (ch) {
          const s = await VyntraServer.findById(ch.serverId).lean();
          if (s && s.owner !== username && !(s.admins||[]).includes(username)) {
            sendTo(username, { type: 'system', text: '❌ Only admins can post in announcement channels' });
            return;
          }
        }
      }
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const isChannel = mongoose.Types.ObjectId.isValid(currentChan);
      const doc = isChannel
        ? { channelId: new mongoose.Types.ObjectId(currentChan), user: username, text: data.text, fileUrl: data.fileUrl, fileName: data.fileName, fileType: data.fileType, replyTo: data.replyTo||null, id, reactions: {}, createdAt: new Date() }
        : { room: currentChan, user: username, text: data.text, fileUrl: data.fileUrl, fileName: data.fileName, fileType: data.fileType, replyTo: data.replyTo||null, id, reactions: {}, createdAt: new Date() };
      bufferMessage(doc);
      const out = { type: 'chat', channelId: currentChan, room: currentChan, user: username, text: data.text, fileUrl: data.fileUrl, fileName: data.fileName, fileType: data.fileType, replyTo: data.replyTo||null, id, reactions: {}, seenBy: [] };
      if (activeChannels[currentChan]) {
        const recipientUsers = await User.find({ username: { $in: [...activeChannels[currentChan]] } }, 'username blockedUsers').lean();
        activeChannels[currentChan].forEach(u => {
          const recip = recipientUsers.find(r => r.username === u);
          if (recip && (recip.blockedUsers||[]).includes(username)) return; // blocked
          sendTo(u, out);
        });
      }
      // Push-notify offline channel members
      if (mongoose.Types.ObjectId.isValid(currentChan)) {
        (async () => {
          try {
            const ch = await Channel.findById(currentChan).lean();
            if (!ch) return;
            const srv = await VyntraServer.findById(ch.serverId).lean();
            if (!srv) return;
            const allMembers = [...new Set([srv.owner, ...(srv.admins||[]), ...(srv.members||[])])];
            const online = new Set(activeChannels[currentChan] || []);
            const snippet = data.text ? data.text.slice(0,100) : (data.fileName || '📎 attachment');
            for (const member of allMembers) {
              if (member !== username && !online.has(member)) {
                pushToUser(member, {
                  type: 'message', title: `${username} · #${ch.name}`,
                  body: snippet, channelId: currentChan, url: '/',
                }).catch(()=>{});
              }
            }
          } catch(e) {}
        })();
      }
      return;
    }

    /* TYPING */
    if (data.type === 'typing' && currentChan) {
      broadcastChannel(currentChan, { type: 'typing', user: username, channelId: currentChan }, username);
      // Auto-stop after 3s server-side (client also sends stop)
      if (!typingTimers[currentChan]) typingTimers[currentChan] = {};
      clearTimeout(typingTimers[currentChan][username]);
      typingTimers[currentChan][username] = setTimeout(() => {
        broadcastChannel(currentChan, { type: 'typing_stop', user: username, channelId: currentChan }, username);
      }, 3000);
      return;
    }
    if (data.type === 'typing_stop' && currentChan) {
      broadcastChannel(currentChan, { type: 'typing_stop', user: username, channelId: currentChan }, username);
      if (typingTimers[currentChan]) clearTimeout(typingTimers[currentChan][username]);
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
      if (activeChannels[chanId]) activeChannels[chanId].forEach(u => sendTo(u, { type: 'chat', channelId: chanId, room: chanId, user: msg.user, text: msg.text, fileUrl: msg.fileUrl, fileName: msg.fileName, fileType: msg.fileType, id: msg.id, reactions }));
      return;
    }

    /* EDIT MESSAGE */
    if (data.type === 'msg_edit') {
      const msg = await Message.findOne({ id: data.messageId });
      if (!msg || msg.user !== username) return;
      const newText = (data.text || '').trim();
      if (!newText) return;
      msg.text = newText;
      msg.editedAt = new Date();
      await msg.save();
      const chanId = msg.channelId ? msg.channelId.toString() : msg.room;
      if (activeChannels[chanId]) activeChannels[chanId].forEach(u =>
        sendTo(u, { type: 'msg_edited', id: msg.id, text: newText, chanId })
      );
      return;
    }

    /* DELETE MESSAGE */
    if (data.type === 'msg_delete') {
      const msg = await Message.findOne({ id: data.messageId });
      if (!msg) return;
      // Allow: own message, or server owner/admin
      let allowed = msg.user === username;
      if (!allowed && msg.channelId) {
        const ch = await Channel.findById(msg.channelId).lean();
        if (ch) {
          const srv = await VyntraServer.findById(ch.serverId).lean();
          if (srv && (srv.owner === username || (srv.admins||[]).includes(username))) allowed = true;
        }
      }
      if (!allowed) return;
      await Message.deleteOne({ id: data.messageId });
      const chanId = msg.channelId ? msg.channelId.toString() : msg.room;
      if (activeChannels[chanId]) activeChannels[chanId].forEach(u =>
        sendTo(u, { type: 'msg_deleted', id: data.messageId, chanId })
      );
      return;
    }

    /* SEEN RECEIPT */
    if (data.type === 'msg_seen') {
      // Mark a message as seen by this user
      const msg = await Message.findOne({ id: data.messageId });
      if (!msg || msg.user === username) return; // don't mark your own
      if (msg.seenBy && msg.seenBy.includes(username)) return; // already marked
      msg.seenBy = [...(msg.seenBy || []), username];
      await msg.save();
      // Notify the sender
      const chanId = msg.channelId ? msg.channelId.toString() : msg.room;
      sendTo(msg.user, { type: 'msg_seen_ack', id: msg.id, seenBy: msg.seenBy, chanId });
      return;
    }

    /* FRIENDS */
    if (data.type === 'friend_request') {
      const target = await User.findOne({ username: data.to });
      if (!target) return;
      if ((target.blockedUsers||[]).includes(username)) return; // blocked
      await User.updateOne({ username: data.to }, { $addToSet: { pendingFriends: username } });
      sendTo(data.to, { type: 'friend_request', from: username });
      sendTo(username, { type: 'friend_request_sent', to: data.to });
      if (!(data.to in clients)) {
        pushToUser(data.to, { type:'friend_request', title:`👋 Friend request from ${username}`, body:'Tap to open Vyntra', url:'/' }).catch(()=>{});
      }
      return;
    }
    if (data.type === 'friend_accept') {
      const [u1,u2] = [username,data.from];
      await User.updateOne({ username: u1 }, { $addToSet: { friends: u2 }, $pull: { pendingFriends: u2 } });
      await User.updateOne({ username: u2 }, { $addToSet: { friends: u1 } });
      sendTo(u1, { type: 'friends_update', friends: (await User.findOne({username:u1})).friends });
      sendTo(u2, { type: 'friends_update', friends: (await User.findOne({username:u2})).friends });
      sendTo(u2, { type: 'friend_accepted', by: u1 });
      return;
    }
    if (data.type === 'friend_decline') {
      await User.updateOne({ username }, { $pull: { pendingFriends: data.from } });
      sendTo(data.from, { type: 'friend_declined', by: username });
      return;
    }
    if (data.type === 'unfriend') {
      await User.updateOne({ username }, { $pull: { friends: data.username } });
      await User.updateOne({ username: data.username }, { $pull: { friends: username } });
      sendTo(username, { type: 'friends_update', friends: (await User.findOne({username})).friends });
      sendTo(data.username, { type: 'unfriended', by: username });
      return;
    }

    /* CALL SIGNALING */
    if (data.type === 'call_request') {
      sendTo(data.to, { type: 'call_incoming', from: username, lvRoom: data.lvRoom, chatRoom: data.chatRoom });
      if (!(data.to in clients)) {
        pushToUser(data.to, { type:'call', title:`📞 ${username} is calling`, body:'Tap to answer on Vyntra', url:'/' }).catch(()=>{});
      }
      return;
    }
    if (data.type === 'call_accept')  { sendTo(data.to, { type: 'call_accepted', from: username }); return; }
    if (data.type === 'call_decline') { sendTo(data.to, { type: 'call_declined', from: username }); return; }
    if (data.type === 'call_cancel')  { sendTo(data.to, { type: 'call_ended',    from: username }); return; }

    /* CALL ROOM TRACKING */
    if (data.type === 'call_join_room') {
      const cr = ensureCallRoom(data.lvRoom);
      cr.members.add(username);
      // Broadcast updated member list to call room
      cr.members.forEach(m => sendTo(m, { type: 'call_room_members', lvRoom: data.lvRoom, members: [...cr.members] }));
      return;
    }
    if (data.type === 'call_leave_room') {
      const cr = callRooms[data.lvRoom];
      if (cr) {
        cr.members.delete(username);
        if (cr.members.size === 0) { delete callRooms[data.lvRoom]; }
        else cr.members.forEach(m => sendTo(m, { type: 'call_room_members', lvRoom: data.lvRoom, members: [...cr.members] }));
      }
      return;
    }

    /* EPHEMERAL CALL CHAT */
    if (data.type === 'call_chat') {
      const cr = callRooms[data.lvRoom];
      if (!cr || !cr.members.has(username)) return;
      const msg = { type: 'call_chat', lvRoom: data.lvRoom, user: username, text: data.text, ts: Date.now() };
      cr.members.forEach(m => sendTo(m, msg));
      return;
    }

    /* CALL POLLS */
    if (data.type === 'call_poll_create') {
      const cr = ensureCallRoom(data.lvRoom);
      if (!cr.members.has(username)) return;
      const pollId = crypto.randomBytes(6).toString('hex');
      const poll = {
        id: pollId, creator: username, question: data.question,
        options: data.options.map((o, i) => ({ id: i, text: o, votes: [] })),
        createdAt: Date.now(), open: true,
      };
      cr.polls.set(pollId, poll);
      cr.members.forEach(m => sendTo(m, { type: 'call_poll_new', lvRoom: data.lvRoom, poll }));
      return;
    }
    if (data.type === 'call_poll_vote') {
      const cr = callRooms[data.lvRoom];
      if (!cr) return;
      const poll = cr.polls.get(data.pollId);
      if (!poll || !poll.open) return;
      // Remove previous vote, add new one
      poll.options.forEach(o => { o.votes = o.votes.filter(v => v !== username); });
      const opt = poll.options.find(o => o.id === data.optionId);
      if (!opt) return;
      opt.votes.push(username);
      cr.members.forEach(m => sendTo(m, { type: 'call_poll_update', lvRoom: data.lvRoom, poll }));
      return;
    }
    if (data.type === 'call_poll_end') {
      const cr = callRooms[data.lvRoom];
      if (!cr) return;
      const poll = cr.polls.get(data.pollId);
      if (!poll || poll.creator !== username) return;
      poll.open = false;
      cr.members.forEach(m => sendTo(m, { type: 'call_poll_update', lvRoom: data.lvRoom, poll }));
      return;
    }

    /* CHAT POLLS (channel) */
    if (data.type === 'chat_poll_create' && currentChan) {
      const pollId = crypto.randomBytes(6).toString('hex');
      const poll = {
        id: pollId, creator: username, question: data.question,
        options: data.options.map((o, i) => ({ id: i, text: o, votes: [] })),
        createdAt: Date.now(), open: true, chanId: currentChan,
      };
      // Store in memory on the channel activeChannels scope (not persisted)
      if (!activeChannels._polls) activeChannels._polls = {};
      activeChannels._polls[pollId] = poll;
      if (activeChannels[currentChan]) activeChannels[currentChan].forEach(u =>
        sendTo(u, { type: 'chat_poll_new', poll })
      );
      return;
    }
    if (data.type === 'chat_poll_vote') {
      const poll = activeChannels._polls && activeChannels._polls[data.pollId];
      if (!poll || !poll.open) return;
      poll.options.forEach(o => { o.votes = o.votes.filter(v => v !== username); });
      const opt = poll.options.find(o => o.id === data.optionId);
      if (!opt) return;
      opt.votes.push(username);
      if (activeChannels[poll.chanId]) activeChannels[poll.chanId].forEach(u =>
        sendTo(u, { type: 'chat_poll_update', poll })
      );
      return;
    }
    if (data.type === 'chat_poll_end') {
      const poll = activeChannels._polls && activeChannels._polls[data.pollId];
      if (!poll || poll.creator !== username) return;
      poll.open = false;
      if (activeChannels[poll.chanId]) activeChannels[poll.chanId].forEach(u =>
        sendTo(u, { type: 'chat_poll_update', poll })
      );
      return;
    }
  });

  ws.on('close', () => {
    if (!username) return;
    delete clients[username];
    if (currentChan && activeChannels[currentChan]) {
      activeChannels[currentChan].delete(username);
      broadcastChannelUsers(currentChan);
    }
    // Remove from any call rooms
    Object.entries(callRooms).forEach(([lvRoom, cr]) => {
      if (cr.members.has(username)) {
        cr.members.delete(username);
        if (cr.members.size === 0) delete callRooms[lvRoom];
        else cr.members.forEach(m => sendTo(m, { type: 'call_room_members', lvRoom, members: [...cr.members] }));
      }
    });
    broadcastAll({ type: 'online_users', users: Object.keys(clients) });
  });
});

server.listen(PORT, () => console.log(`Vyntra running on port ${PORT}`));
