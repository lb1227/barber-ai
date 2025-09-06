// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio connected");

  twilioWs.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      console.log("📨 Twilio event:", evt.event);

      if (evt.event === "media") {
        console.log("🎤 Got audio frame, size:", evt.media.payload.length);
      }

      if (evt.event === "start") {
        console.log("📞 Call started", evt.start);
      }

      if (evt.event === "stop") {
        console.log("🛑 Call ended");
      }
    } catch (e) {
      console.error("Parse error", e);
    }
  });

  twilioWs.on("close", () => console.log("❌ Twilio WS closed"));
  twilioWs.on("error", (err) => console.error("Twilio WS error", err));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("🚀 Server running on", PORT));
