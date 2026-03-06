const express    = require("express");
const http       = require("http");
const WebSocket  = require("ws");
const mongoose   = require("mongoose");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(__dirname));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const MONGO_URI  = process.env.MONGO_URI  || "";

/* ── MongoDB connection ── */
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(e  => console.error("MongoDB error:", e));

/* ── Schemas ── */
const userSchema = new mongoose.Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, trim: true },
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

/* ── Predefined rooms ── */
const PREDEFINED_ROOMS = [
  "general","memes","dev","music","games","anime","art","tech","random",
  "news","sports","study","finance","travel","food","pets","movies","tv","fun"
];

/* ── In-memory room state ── */
const rooms = {};
PREDEFINED_ROOMS.forEach(r => rooms[r] = { clients: new Set() });

/* ── REST: Register ── */
app.post("/auth/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: "All fields required" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, username, password: hash });
    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, username: user.username });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── REST: Login ── */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "All fields required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid email or password" });

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

  // Persist to MongoDB (upsert so reactions update in place)
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

    /* Authenticate via JWT on first message */
    if (data.type === "auth") {
      try {
        const payload = jwt.verify(data.token, JWT_SECRET);
        ws.username = payload.username;
        ws.send(JSON.stringify({ type: "auth_ok", username: ws.username }));
      } catch {
        ws.send(JSON.stringify({ type: "auth_err", error: "Invalid token" }));
      }
      // Always send room list after auth attempt
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

      // Leave previous room
      if (ws.room && rooms[ws.room]) {
        rooms[ws.room].clients.delete(ws);
        broadcastMessage(ws.room, { type: "system", text: `${ws.username} left ${ws.room}` });
        broadcastUsers(ws.room);
      }

      ws.room = room;
      rooms[room].clients.add(ws);

      // Send last 50 messages from DB
      try {
        const history = await Message.find({ room })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();
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
      const { messageId, emoji } = data;
      try {
        const msg = await Message.findOne({ msgId: messageId });
        if (!msg) return;
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const idx = msg.reactions[emoji].indexOf(ws.username);
        if (idx >= 0) msg.reactions[emoji].splice(idx, 1);
        else msg.reactions[emoji].push(ws.username);
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
      if (ws.username) {
        broadcastMessage(ws.room, { type: "system", text: `${ws.username} left ${ws.room}` });
      }
      broadcastUsers(ws.room);
    }
  });
});

/* ── Start ── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vyntra running on http://localhost:${PORT}`);
});
