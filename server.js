const express = require("express")
const http = require("http")
const WebSocket = require("ws")

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

app.use(express.static(__dirname))

const rooms = {}

function broadcastUsers(room){

    if(!rooms[room]) return

    const users = []

    for(const client of rooms[room]){
        if(client.username){
            users.push(client.username)
        }
    }

    const payload = JSON.stringify({
        type:"users",
        room:room,
        users:users
    })

    for(const client of rooms[room]){
        if(client.readyState === WebSocket.OPEN){
            client.send(payload)
        }
    }
}

wss.on("connection",(ws)=>{

    ws.username = "anonymous"
    ws.room = null

    ws.on("message",(raw)=>{

        let data
        try{
            data = JSON.parse(raw)
        }catch{
            return
        }

        if(data.type === "setname"){
            ws.username = data.name
            return
        }

        if(data.type === "join"){

            ws.room = data.room

            if(!rooms[ws.room]){
                rooms[ws.room] = new Set()
            }

            rooms[ws.room].add(ws)

            const joinMsg = JSON.stringify({
                type:"system",
                text:ws.username + " joined " + ws.room
            })

            for(const client of rooms[ws.room]){
                if(client.readyState === WebSocket.OPEN){
                    client.send(joinMsg)
                }
            }

            broadcastUsers(ws.room)

            return
        }

        if(data.type === "message" && ws.room){

            const msg = JSON.stringify({
                type:"chat",
                room:ws.room,
                user:ws.username,
                text:data.text
            })

            for(const client of rooms[ws.room]){
                if(client.readyState === WebSocket.OPEN){
                    client.send(msg)
                }
            }
        }

    })

    ws.on("close",()=>{

        if(ws.room && rooms[ws.room]){

            rooms[ws.room].delete(ws)

            const leaveMsg = JSON.stringify({
                type:"system",
                text:ws.username + " left " + ws.room
            })

            for(const client of rooms[ws.room]){
                if(client.readyState === WebSocket.OPEN){
                    client.send(leaveMsg)
                }
            }

            broadcastUsers(ws.room)
        }
    })
})

app.get("/",(req,res)=>{
    res.sendFile(__dirname + "/index.html")
})

const PORT = process.env.PORT || 3000

server.listen(PORT,"0.0.0.0",()=>{
    console.log("Vyntra running on http://localhost:" + PORT)
})