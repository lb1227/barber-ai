// server.js  — minimal Twilio Media Streams WebSocket endpoint (no OpenAI yet)
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

// simple health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Twilio status callbacks (optional; useful once TwiML includes statusCallback)
app.post("/twilio-status", express.urlencoded({ extended: false }), (req, res) => {
  console.log("Twilio status callback:", req.body);
  res.sendStatus(200);
});

const server = http.createServer(app);

// ---- WebSocket for Twilio Media Streams on /twilio
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (ws, req) => {
  console.log("✅ Twilio WS connected from", req.socket.remoteAddress);

  // keep-alive so proxies don’t kill the socket
  const ping = setInterval(() => {
    try { ws.ping(); } catch { /* ignore */ }
  }, 15000);

  ws.on("message", (data) => {
    // Twilio sends JSON frames: {event, ...}
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") {
        console.log("▶️  Media stream started:", {
          streamSid: msg.streamSid,
          track: msg.start?.tracks,
          mediaFormat: msg.start?.mediaFormat,
        });
      } else if (msg.event === "media") {
        // we don’t process audio yet — just count frames to prove it’s flowing
        // msg.media.payload is base64 μ-law audio @ 8kHz
      } else if (msg.event === "mark") {
        console.log("Mark:", msg.mark?.name);
      } else if (msg.event === "stop") {
        console.log("⏹️  Media stream stopped:", msg.streamSid);
      } else {
        console.log("Twilio event:", msg.event);
      }
    } catch (e) {
      console.log("Non-JSON WS frame len=", data?.length || 0);
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(ping);
    console.log("🔌 Twilio WS closed:", code, reason?.toString() || "");
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
  });
});

// start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("HTTP server listening on", PORT);
  console.log("WS endpoint  : wss://<your-host>/twilio");
});
