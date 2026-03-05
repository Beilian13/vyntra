const express = require("express")
const http = require("http")
const WebSocket = require("ws")

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

app.use(express.static(__dirname))

// Predefined expressive rooms
const predefinedRooms = [
  "general","memes","dev","music","gaming","movies","anime","tech",
  "art","sports","fun","food","travel","books","coding","pets",
  "life","science","random","chat-lounge"
]

// rooms: { roomName: { clients: Set(ws), messages: [] } }
const rooms = {}
predefinedRooms.forEach(r => rooms[r] = { clients: new Set(), messages: [] })

const allClients = new Set()

function broadcastUsers(room){
    if(!rooms[room]) return
    const users = Array.from(rooms[room].clients).map(c => c.username)
    const payload = JSON.stringify({ type:"users", room, users })
    rooms[room].clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(payload) })
}

function broadcastMessage(room, msgObj){
    if(!rooms[room]) return
    rooms[room].clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msgObj)) })
}

// Broadcast predefined room list to all clients
function broadcastRooms(){
    const payload = JSON.stringify({ type:"rooms", rooms:predefinedRooms })
    allClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(payload) })
}

wss.on("connection",(ws)=>{
    ws.username = "anonymous"
    ws.room = null
    allClients.add(ws)

    // Send predefined room list immediately
    ws.send(JSON.stringify({ type:"rooms", rooms:predefinedRooms }))

    ws.on("message",(raw)=>{
        let data
        try { data = JSON.parse(raw) } catch { return }

        if(data.type === "setname"){
            ws.username = data.name
            return
        }

        if(data.type === "join"){
            const room = data.room
            ws.room = room
            if(!rooms[room]) return  // ignore invalid rooms

            rooms[room].clients.add(ws)

            const joinMsg = { type:"system", text: ws.username + " joined " + room }
            broadcastMessage(room, joinMsg)
            broadcastUsers(room)

            // Send last 50 messages
            const recent = rooms[room].messages.slice(-50)
            recent.forEach(m => { if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) })
            return
        }

        if(data.type === "message"){
    if(!ws.room){
        console.warn("Message received but ws.room is undefined. Ignoring.", data)
        return
    }
    if(!rooms[ws.room]){
        console.warn("Message received for non-existent room:", ws.room)
        return
    }

    const msgObj = {
        type:"chat",
        id:Date.now()+"_"+Math.floor(Math.random()*1000),
        room: ws.room,
        user: ws.username,
        text: data.text,
        reactions: {}
    }

    rooms[ws.room].messages.push(msgObj)
    broadcastMessage(ws.room, msgObj)
}

        if(data.type === "reaction" && ws.room){
            const roomData = rooms[ws.room]
            if(!roomData) return
            const msg = roomData.messages.find(m => m.id === data.messageId)
            if(!msg) return
            if(!msg.reactions[data.emoji]) msg.reactions[data.emoji] = []
            if(!msg.reactions[data.emoji].includes(ws.username)) msg.reactions[data.emoji].push(ws.username)
            broadcastMessage(ws.room, msg)
        }
    })

    ws.on("close",()=>{
        allClients.delete(ws)
        if(ws.room && rooms[ws.room]){
            rooms[ws.room].clients.delete(ws)
            const leaveMsg = { type:"system", text: ws.username + " left " + ws.room }
            broadcastMessage(ws.room, leaveMsg)
            broadcastUsers(ws.room)
        }
    })
})

app.get("/",(req,res)=> res.sendFile(__dirname + "/index.html"))

const PORT = process.env.PORT || 3000
server.listen(PORT, "0.0.0.0", ()=> console.log("Vyntra running on http://localhost:" + PORT))
