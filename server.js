const express = require("express")
const http = require("http")
const WebSocket = require("ws")

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

app.use(express.static(__dirname))

// rooms: { roomName: { clients: Set(ws), messages: [] } }
const rooms = {}

function broadcastUsers(room){
    if(!rooms[room]) return
    const users = []
    for(const client of rooms[room].clients){
        if(client.username) users.push(client.username)
    }
    const payload = JSON.stringify({ type:"users", room, users })
    for(const client of rooms[room].clients){
        if(client.readyState === WebSocket.OPEN) client.send(payload)
    }
}

function broadcastMessage(room, msgObj){
    if(!rooms[room]) return
    for(const client of rooms[room].clients){
        if(client.readyState === WebSocket.OPEN){
            client.send(JSON.stringify(msgObj))
        }
    }
}

wss.on("connection",(ws)=>{
    ws.username = "anonymous"
    ws.room = null

    ws.on("message",(raw)=>{
        let data
        try { data = JSON.parse(raw) } catch { return }

        if(data.type === "setname"){
            ws.username = data.name
            return
        }

        if(data.type === "join"){
            ws.room = data.room
            if(!rooms[ws.room]){
                rooms[ws.room] = { clients: new Set(), messages: [] }
            }
            rooms[ws.room].clients.add(ws)

            const joinMsg = { type:"system", text: ws.username + " joined " + ws.room }
            broadcastMessage(ws.room, joinMsg)
            broadcastUsers(ws.room)

            // Send existing messages in the room to the new user
            rooms[ws.room].messages.forEach(m => {
                if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
            })
            return
        }

        if(data.type === "message" && ws.room){
            // Normal chat message
            const msgObj = {
                type:"chat",
                id:Date.now()+"_"+Math.floor(Math.random()*1000),
                room: ws.room,
                user: ws.username,
                text: data.text,
                reactions: {} // emoji: [usernames]
            }
            rooms[ws.room].messages.push(msgObj)
            broadcastMessage(ws.room, msgObj)
        }

        if(data.type === "reaction" && ws.room){
            // { messageId, emoji }
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
