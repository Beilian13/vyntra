const express   = require("express");
const http      = require("http");
const https     = require("https");
const WebSocket = require("ws");
const mongoose  = require("mongoose");
const bcrypt    = require("bcrypt");
const jwt       = require("jsonwebtoken");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(__dirname));
app.use(express.json());

const JWT_SECRET    = process.env.JWT_SECRET    || "dev_secret";
const MONGO_URI     = process.env.MONGO_URI     || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

/* ── MongoDB ── */
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(e  => console.error("MongoDB error:", e));

/* ── Schemas ── */
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  room:      { type: String, required: true },
  user:      { type: String, required: true },
  text:      { type: String, required: true },
  msgId:     { type: String, required: true, unique: true },
  reactions: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
});

const User    = mongoose.model("User",    userSchema);
const Message = mongoose.model("Message", messageSchema);

/* ── In-memory 2FA codes: { username -> { code, expires } } ── */
const pendingCodes = {};

/* ── Rooms ── */
const PREDEFINED_ROOMS = [
  "general","memes","dev","music","games","anime","art","tech","random",
  "news","sports","study","finance","travel","food","pets","movies","tv","fun"
];
const rooms = {};
PREDEFINED_ROOMS.forEach(r => rooms[r] = { clients: new Set() });

/* ── Send 2FA email via Resend ── */
function send2FAEmail(email, username, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: "Vyntra <onboarding@resend.dev>",
      to:   [email],
      subject: "Your Vyntra login code",
      html: `<div style="font-family:sans-serif;max-width:400px;margin:auto;background:#0f1220;color:#eef2ff;padding:32px;border-radius:12px">
        <h2 style="margin:0 0 8px;color:#6c7cff">Vyntra</h2>
        <p style="color:#9aa0b4;margin:0 0 24px">Hi <b>${username}</b>, here is your login code:</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:8px;text-align:center;padding:20px;background:#161827;border-radius:8px;color:#eef2ff">${code}</div>
        <p style="color:#9aa0b4;font-size:13px;margin-top:16px;text-align:center">This code expires in 10 minutes.</p>
      </div>`
    });
    const req = https.request({
      hostname: "api.resend.com",
      path:     "/emails",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${RESEND_API_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error("Resend error " + res.statusCode + ": " + data));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── REST: Register ── */
app.post("/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields required" });
    if (username.length < 2 || username.length > 20)
      return res.status(400).json({ error: "Username must be 2–20 characters" });

    const existingUser  = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, "i") } });
    if (existingUser)  return res.status(409).json({ error: "Username already taken" });

    const existingEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingEmail) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hash });
    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, username: user.username });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── REST: Login step 1 — verify username+password, send 2FA code ── */
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });

    const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, "i") } });
    if (!user) return res.status(401).json({ error: "Invalid username or password" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid username or password" });

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));
    pendingCodes[user.username] = { code, expires: Date.now() + 10 * 60 * 1000 };

    await send2FAEmail(user.email, user.username, code);
    res.json({ requires2FA: true, username: user.username });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── REST: Login step 2 — verify 2FA code, return JWT ── */
app.post("/auth/verify", async (req, res) => {
  try {
    const { username, code } = req.body;
    if (!username || !code)
      return res.status(400).json({ error: "Username and code required" });

    const pending = pendingCodes[username];
    if (!pending)               return res.status(401).json({ error: "No code requested" });
    if (Date.now() > pending.expires) {
      delete pendingCodes[username];
      return res.status(401).json({ error: "Code expired, please log in again" });
    }
    if (pending.code !== code.trim())
      return res.status(401).json({ error: "Incorrect code" });

    delete pendingCodes[username];

    const user  = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, "i") } });
    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, username: user.username });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── Helpers ── */
function broadcastUsers(room) {
  if (!rooms[room]) return;
  const users = [];
  for (const client of rooms[room].clients) {
    if (client.username) users.push(client.username);
  }
  const payload = JSON.stringify({ type: "users", room, users });
  for (const client of rooms[room].clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

async function broadcastMessage(room, msgObj) {
  if (!rooms[room]) return;
  if (msgObj.type === "chat") {
    try {
      await Message.findOneAndUpdate(
        { msgId: msgObj.id },
        { room, user: msgObj.user, text: msgObj.text, msgId: msgObj.id, reactions: msgObj.reactions },
        { upsert: true, new: true }
      );
    } catch(e) { console.error("DB save error:", e); }
  }
  const payload = JSON.stringify(msgObj);
  for (const client of rooms[room].clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

/* ── WebSocket ── */
wss.on("connection", (ws) => {
  ws.username = null;
  ws.room     = null;

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "auth") {
      try {
        const payload = jwt.verify(data.token, JWT_SECRET);
        ws.username = payload.username;
        ws.send(JSON.stringify({ type: "auth_ok", username: ws.username }));
      } catch {
        ws.send(JSON.stringify({ type: "auth_err", error: "Invalid token" }));
        return;
      }
      ws.send(JSON.stringify({ type: "rooms", rooms: PREDEFINED_ROOMS }));
      return;
    }

    if (!ws.username) {
      ws.send(JSON.stringify({ type: "error", error: "Not authenticated" }));
      return;
    }

    if (data.type === "join") {
      const room = data.room;
      if (!PREDEFINED_ROOMS.includes(room)) return;

      if (ws.room && rooms[ws.room]) {
        rooms[ws.room].clients.delete(ws);
        broadcastMessage(ws.room, { type: "system", text: `${ws.username} left ${ws.room}` });
        broadcastUsers(ws.room);
      }

      ws.room = room;
      rooms[room].clients.add(ws);

      try {
        const history = await Message.find({ room }).sort({ createdAt: -1 }).limit(50).lean();
        history.reverse().forEach(m => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "chat", room: m.room, user: m.user,
              text: m.text, id: m.msgId, reactions: m.reactions || {}
            }));
          }
        });
      } catch(e) { console.error("History fetch error:", e); }

      broadcastMessage(room, { type: "system", text: `${ws.username} joined ${room}` });
      broadcastUsers(room);
      return;
    }

    if (data.type === "message" && ws.room) {
      const msgObj = {
        type: "chat", room: ws.room, user: ws.username,
        text: data.text,
        id: `${Date.now()}_${Math.floor(Math.random() * 9999)}`,
        reactions: {}
      };
      broadcastMessage(ws.room, msgObj);
      return;
    }

    if (data.type === "reaction" && ws.room) {
      try {
        const msg = await Message.findOne({ msgId: data.messageId });
        if (!msg) return;
        if (!msg.reactions[data.emoji]) msg.reactions[data.emoji] = [];
        const idx = msg.reactions[data.emoji].indexOf(ws.username);
        if (idx >= 0) msg.reactions[data.emoji].splice(idx, 1);
        else msg.reactions[data.emoji].push(ws.username);
        msg.markModified("reactions");
        await msg.save();
        broadcastMessage(ws.room, {
          type: "chat", room: msg.room, user: msg.user,
          text: msg.text, id: msg.msgId, reactions: msg.reactions
        });
      } catch(e) { console.error("Reaction error:", e); }
    }
  });

  ws.on("close", () => {
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room].clients.delete(ws);
      if (ws.username) broadcastMessage(ws.room, { type: "system", text: `${ws.username} left ${ws.room}` });
      broadcastUsers(ws.room);
    }
  });
});

/* ── Start ── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vyntra running on http://localhost:${PORT}`);
});
