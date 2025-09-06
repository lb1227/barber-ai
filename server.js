// server.js — minimal "talk-only" bridge: Twilio -> OpenAI (outbound audio only)

const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const PORT = process.env.PORT || 10000;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("OK"));
const server = http.createServer(app);

// Twilio will connect its MediaStreams WebSocket to /media
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

wss.on("connection", (twilioWS) => {
  const tag = Math.random().toString(36).slice(2, 6);
  log(`[${tag}] Twilio connected`);

  // Connect to OpenAI Realtime WS
  const aiURL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
  const aiWS = new WebSocket(aiURL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  aiWS.on("open", () => {
    log(`[${tag}] ✅ OpenAI WS open`);

    // ✅ This is the CORRECT JSON shape. Notice "session: { ... }".
    const sessionUpdate = {
      type: "session.update",
      session: {
        // optional "type": "realtime", // not required, kept minimal
        voice: "alloy",
        modalities: ["audio"],          // ✅ nested under session
        output_audio_format: "g711_ulaw"
      }
    };
    log(`[${tag}] -> OpenAI`, sessionUpdate);
    aiWS.send(JSON.stringify(sessionUpdate));

    // Ask OpenAI to speak one sentence (no input from caller)
    const hello = {
      type: "response.create",
      response: {
        instructions: "Hello, you are connected to Barber AI.",
        modalities: ["audio"]          // ✅ nested under response
      }
    };
    log(`[${tag}] -> OpenAI`, hello);
    aiWS.send(JSON.stringify(hello));
  });

  // Any audio chunks from OpenAI -> send to Twilio MediaStream
  aiWS.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    // Log the first few messages to confirm structure clearly
    if (data.type !== "response.audio.delta") {
      log(`[${tag}] <- OpenAI`, data.type);
    }

    if (data.type === "response.audio.delta" && data.delta) {
      // Twilio expects: { event: "media", media: { payload: base64-ULAW } }
      twilioWS.send(JSON.stringify({
        event: "media",
        media: { payload: data.delta }
      }));
    }

    if (data.type === "response.completed") {
      log(`[${tag}] ✅ AI finished speaking`);
      // give Twilio a moment to flush audio
      setTimeout(() => {
        try { twilioWS.close(); } catch {}
        try { aiWS.close(); } catch {}
      }, 400);
    }

    if (data.type === "error") {
      log(`[${tag}] ❌ OpenAI ERROR`, data);
    }
  });

  aiWS.on("close", () => log(`[${tag}] OpenAI closed`));
  aiWS.on("error", (err) => log(`[${tag}] OpenAI error:`, err));

  // We don't forward caller audio yet; we only let the bot speak.
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "connected") log(`[${tag}] Twilio WS connected`);
      if (data.event === "start") log(`[${tag}] Twilio start`);
      if (data.event === "stop") {
        log(`[${tag}] Twilio stop`);
        try { aiWS.close(); } catch {}
        try { twilioWS.close(); } catch {}
      }
    } catch (_) {}
  });

  twilioWS.on("close", () => log(`[${tag}] Twilio closed`));
  twilioWS.on("error", (err) => log(`[${tag}] Twilio error:`, err));
});

server.listen(PORT, () => {
  console.log("==> Minimal WS server ready at https://barber-ai.onrender.com");
});
