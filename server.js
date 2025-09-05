// server.js — Twilio WS diagnostic sink (ESM). No OpenAI.
// Goal: prove Twilio actually reaches and upgrades to /twilio.
// Env not required.

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

// Basic routes
app.get("/", (_req, res) => res.status(200).send("OK: root"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Log every HTTP request (helps verify Twilio hits your host at all)
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url} UA=${req.headers["user-agent"] || "-"}`);
  next();
});

// Critically: log ALL upgrade attempts (so we know if the proxy even forwards the WS)
server.on("upgrade", (req, socket, head) => {
  console.log(`[UPGRADE] ${req.url} from ${req.headers["x-forwarded-for"] || req.socket.remoteAddress}`);
  // We don't handle the upgrade here because the ws lib will, but the log proves we saw it.
});

// WebSocket server strictly on /twilio
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (ws, req) => {
  console.log(`[WS] Twilio connected on ${req.url}`);

  let streamSid = null;
  let frames = 0;

  // Keep alive (Render + Twilio proxies)
  const keep = setInterval(() => {
    try { ws.ping(); } catch {}
  }, 15000);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid;
        console.log(`[WS] start streamSid=${streamSid}`);
        break;
      case "media":
        frames++;
        if (frames % 50 === 0) {
          console.log(`[WS] media frames=${frames}`);
        }
        // We deliberately do not send audio back; this is just a connectivity test.
        break;
      case "stop":
        console.log("[WS] stop received");
        break;
      default:
        console.log("[WS] event:", msg.event);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Twilio WS closed");
    clearInterval(keep);
  });

  ws.on("error", (err) => {
    console.error("[WS] error:", err);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
