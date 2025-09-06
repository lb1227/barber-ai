// server.js — Twilio <Stream/> echo bridge with deep diagnostics (ESM)

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const app = express();
app.use(express.json());

// Simple health
app.get("/", (_req, res) => res.type("text").send("Twilio Echo Bridge is live"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Twilio Stream status callback -> see start/error/stop reasons
app.post("/twilio-status", (req, res) => {
  console.log("==> Twilio STATUS:", {
    event: req.body.Event || req.body.event || req.body.StatusCallbackEvent,
    streamSid: req.body.StreamSid || req.body.StreamSid,
    callSid: req.body.CallSid,
    timestamp: new Date().toISOString(),
    raw: req.body,
  });
  res.sendStatus(204);
});

const server = http.createServer(app);

// Dedicated WS server; we only upgrade /twilio
const wss = new WebSocketServer({ noServer: true });

// Log ANY upgrade attempts
server.on("upgrade", (request, socket, head) => {
  const url = request.url || "";
  console.log(`==> HTTP upgrade requested for ${url} from ${request.socket.remoteAddress}`);

  if (url === "/twilio") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

function safeJson(buf) {
  try { return JSON.parse(buf.toString()); } catch { return null; }
}

wss.on("connection", (ws, request) => {
  const id = Math.random().toString(36).slice(2, 8);
  console.log(`[${id}] Twilio WS CONNECTED from ${request.socket.remoteAddress}`);

  let streamSid = null;

  // Twilio sends ping frames; reply pong to be explicit
  ws.on("ping", (data) => {
    ws.pong(data);
  });

  // Send periodic keepalive event (Twilio accepts arbitrary JSON messages)
  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: "keepalive", ts: Date.now() }));
    }
  }, 10000);

  ws.on("message", (msg) => {
    const data = safeJson(msg);
    if (!data) return;

    switch (data.event) {
      case "start": {
        streamSid = data.start?.streamSid || null;
        console.log(`[${id}] START streamSid=${streamSid}`);
        // Mark that the server is ready (handy to see in Twilio debugger)
        ws.send(JSON.stringify({
          event: "mark",
          streamSid,
          mark: { name: "server-ready" }
        }));
        break;
      }

      case "media": {
        // Echo audio back (proof that the stream is healthy)
        if (streamSid && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: data.media?.payload || "" },
          }));
        }
        break;
      }

      case "stop": {
        console.log(`[${id}] STOP received`);
        break;
      }

      default: {
        console.log(`[${id}] MESSAGE`, data);
      }
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepAlive);
    console.log(`[${id}] WS CLOSED code=${code} reason=${reason?.toString?.() || ""}`);
  });

  ws.on("error", (err) => {
    console.error(`[${id}] WS ERROR:`, err?.message || err);
  });
});

// Start HTTP server
server.listen(PORT, () => {
  console.log("==> ///////////////////////////////////////////////////");
  console.log("==> Your service is live 🎉");
  console.log("==> Available at your primary URL https://barber-ai.onrender.com");
  console.log("==> ///////////////////////////////////////////////////");
});
