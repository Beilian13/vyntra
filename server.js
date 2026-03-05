// server.js — full updated Vyntra backend with pre-defined rooms, last 50 messages, and reactions
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

/* ---------- Predefined rooms ---------- */
const PREDEFINED_ROOMS = [
  "general","memes","dev","music","games","anime","art","tech","random",
  "news","sports","study","finance","travel","food","pets","movies","tv","fun"
];

/* ---------- Rooms data structure ---------- */
// rooms[roomName] = { clients: Set<WebSocket>, messages: Array<{id,user,text,reactions}> }
const rooms = {};
PREDEFINED_ROOMS.forEach(r => rooms[r] = { clients: new Set(), messages: [] });

/* ---------- Broadcast user list to room ---------- */
function broadcastUsers(room) {
  if(!rooms[room]) return;
  const users = [];
  for(const client of rooms[room].clients){
    if(client.username) users.push(client.username);
  }
  const payload = JSON.stringify({ type:"users", room, users });
  for(const client of rooms[room].clients){
    if(client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

/* ---------- Broadcast new message to room ---------- */
function broadcastMessage(room, msgObj){
  if(!rooms[room]) return;
  // store last 50 messages
  rooms[room].messages.push(msgObj);
  if(rooms[room].messages.length > 50) rooms[room].messages.shift();

  const payload = JSON.stringify(msgObj);
  for(const client of rooms[room].clients){
    if(client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

/* ---------- WebSocket connection ---------- */
wss.on("connection", (ws) => {
  ws.username = "anonymous";
  ws.room = null;

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if(data.type === "setname") {
      ws.username = data.name || "anonymous";
      return;
    }

    if(data.type === "join") {
      const room = data.room;
      if(!PREDEFINED_ROOMS.includes(room)) return;

      // leave previous room
      if(ws.room && rooms[ws.room]){
        rooms[ws.room].clients.delete(ws);
        broadcastUsers(ws.room);
      }

      ws.room = room;
      rooms[room].clients.add(ws);

      // system join message
      const joinMsg = { type:"system", text: ws.username + " joined " + room };
      broadcastMessage(room, joinMsg);

      // send last 50 messages to this client
      const history = rooms[room].messages || [];
      history.forEach(m => {
        if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      });

      broadcastUsers(room);
      return;
    }

    if(data.type === "message" && ws.room){
      const msgObj = {
        type:"chat",
        room: ws.room,
        user: ws.username,
        text: data.text,
        id: Date.now()+"_"+Math.floor(Math.random()*9999),
        reactions: {} // emoji => array of usernames
      };
      broadcastMessage(ws.room, msgObj);
      return;
    }

    if(data.type === "reaction" && ws.room){
      const { messageId, emoji } = data;
      const roomMsgs = rooms[ws.room].messages;
      if(!roomMsgs) return;

      const msg = roomMsgs.find(m=>m.id === messageId);
      if(!msg) return;

      if(!msg.reactions[emoji]) msg.reactions[emoji] = [];
      const userIdx = msg.reactions[emoji].indexOf(ws.username);
      if(userIdx >= 0){
        // toggle off
        msg.reactions[emoji].splice(userIdx,1);
      } else {
        msg.reactions[emoji].push(ws.username);
      }

      broadcastMessage(ws.room, msg);
    }
  });

  ws.on("close", ()=>{
    if(ws.room && rooms[ws.room]){
      rooms[ws.room].clients.delete(ws);
      const leaveMsg = { type:"system", text: ws.username + " left " + ws.room };
      broadcastMessage(ws.room, leaveMsg);
      broadcastUsers(ws.room);
    }
  });

  // send initial rooms list to client
  ws.send(JSON.stringify({ type:"rooms", rooms: PREDEFINED_ROOMS }));
});

/* ---------- HTTP routes ---------- */
app.get("/", (req,res)=>{
  res.sendFile(__dirname + "/index.html");
});

/* ---------- Start server ---------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT,"0.0.0.0",()=>{
  console.log(`Vyntra running on http://localhost:${PORT}`);
});
