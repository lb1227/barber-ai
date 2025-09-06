// server.js — Twilio WS upgrade diagnostic (no OpenAI)
// ESM module (your package.json has "type": "module")

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

// Basic health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// If you later add statusCallback in TwiML
app.post("/twilio-status", express.urlencoded({ extended: false }), (req, res) => {
  console.log("Twilio status callback body:", req.body);
  res.sendStatus(200);
});

// Create HTTP server
const server = http.createServer(app);

// We’ll attach WSS manually in the 'upgrade' event so we can log attempts
const wss = new WebSocketServer({ noServer: true });

// When a WebSocket connection is established
wss.on("connection", (ws, req) => {
  console.log("✅ WS CONNECTED on", req.url, "from", req.socket.remoteAddress);

  const keepAlive = setInterval(() => {
    try { ws.ping(); } catch {}
  }, 15000);

  ws.on("message", (data) => {
    // Twilio sends JSON frames: {event: 'start'|'media'|'stop'...}
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") {
        console.log("▶️ media START", {
          streamSid: msg.streamSid,
          tracks: msg.start?.tracks,
          fmt: msg.start?.mediaFormat
        });
      } else if (msg.event === "media") {
        // we just count; no processing
      } else if (msg.event === "stop") {
        console.log("⏹️ media STOP", msg.streamSid);
      } else {
        console.log("Twilio event:", msg.event);
      }
    } catch {
      console.log("Non-JSON frame length:", data?.length || 0);
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepAlive);
    console.log("🔌 WS CLOSED", code, reason?.toString() || "");
  });

  ws.on("error", (err) => console.error("WS error:", err));
});

// LOG every upgrade (this fires even if WS isn’t accepted)
server.on("upgrade", (req, socket, head) => {
  console.log("🔎 HTTP UPGRADE attempt:", {
    url: req.url,
    host: req.headers.host,
    ua: req.headers["user-agent"],
    upgrade: req.headers.upgrade,
    proto: req.headers["sec-websocket-protocol"]
  });

  // Accept only the /twilio path
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    // Reject anything else so we can see it happened
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("HTTP listening on", PORT);
  console.log("WS endpoint:", "wss://<your-host>/twilio");
});
