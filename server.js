// server.js  — Minimal Twilio <Stream/> echo bridge with heavy logging (ESM)

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const app = express();

// Basic health routes (useful to confirm Render is serving)
app.get("/", (_req, res) => {
  res.type("text").send("Twilio Echo Bridge is live");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

const server = http.createServer(app);

// WebSocket server, but we will only accept upgrades for /twilio
const wss = new WebSocketServer({ noServer: true });

// Helper: safe JSON parse
function tryParse(buf) {
  try { return JSON.parse(buf.toString()); } catch { return null; }
}

wss.on("connection", (ws, request) => {
  const id = Math.random().toString(36).slice(2, 8);
  console.log(`[${id}] Twilio WS connected from ${request.socket.remoteAddress}`);

  let streamSid = null;

  // Send periodic keepalives back to Twilio so the stream doesn’t idle-close
  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: "keepalive" }));
    }
  }, 15000);

  ws.on("message", (msg) => {
    const data = tryParse(msg);
    if (!data) return;

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      console.log(`[${id}] start: streamSid=${streamSid}`);
      return;
    }

    if (data.event === "media") {
      // ECHO BACK the same audio to Twilio so you can hear yourself.
      if (streamSid && ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: data.media?.payload || "" },
          })
        );
      }
      return;
    }

    if (data.event === "stop") {
      console.log(`[${id}] stop received`);
      return;
    }

    if (data.event === "mark") {
      // sometimes Twilio sends markers (safe to ignore)
      return;
    }

    if (data.event === "keepalive") {
      // Twilio may also send keepalives; no action needed.
      return;
    }

    console.log(`[${id}] Unhandled message:`, data);
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepAlive);
    console.log(`[${id}] Twilio WS closed. code=${code} reason=${reason}`);
  });

  ws.on("error", (err) => {
    console.error(`[${id}] Twilio WS error:`, err?.message || err);
  });
});

// Only upgrade WS for /twilio; refuse others (avoids random probes)
server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (url === "/twilio") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log("==>  ///////////////////////////////////////////////////");
  console.log("==>  Your service is live 🎉");
  console.log("==>  Available at your primary URL https://barber-ai.onrender.com");
  console.log("==>  ///////////////////////////////////////////////////");
});
