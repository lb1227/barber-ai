// Minimal TALK-ONLY Twilio <-> OpenAI Realtime bridge.
// - Twilio connects to wss://<your-app>/media via TwiML <Connect><Stream/>
// - We open an OpenAI Realtime WS
// - We ask OpenAI to SPEAK in g711_ulaw (8k) and pipe chunks straight back to Twilio
// - We IGNORE microphone input for now

const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("OK"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Utility logging helper
const log = (...args) => console.log(new Date().toISOString(), ...args);

// Handles the /media WS upgrade
server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/media") {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// --- Core bridge ---
wss.on("connection", async (twilioWS) => {
  const callId = Math.random().toString(36).slice(2, 6);
  log(`[${callId}] Twilio connected`);

  // 1) Open OpenAI Realtime WS
  const aiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const aiWS = new WebSocket(aiURL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  let aiOpen = false;
  let twilioOpen = true;

  // Close helpers
  const closeBoth = (why) => {
    try { twilioWS.readyState === WebSocket.OPEN && twilioWS.close(); } catch {}
    try { aiWS.readyState === WebSocket.OPEN && aiWS.close(); } catch {}
    log(`[${callId}] closed both (${why})`);
  };

  // 2) When OpenAI is open, set session → audio out g711_ulaw + speak
  aiWS.on("open", () => {
    aiOpen = true;
    log(`[${callId}] [OpenAI] WS open`);

    // Force talk-only session with μ-law output (8k), no mic used yet
    aiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio"],        // only audio for now
        voice: "alloy",               // any of: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar
        output_audio_format: "g711_ulaw"
      }
    }));

    // Make it speak immediately
    aiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions:
          "Hi! You're through to the Barber AI test. If you hear this, audio out is working. We'll add listening next."
      }
    }));
  });

  aiWS.on("error", (err) => {
    log(`[${callId}] [OpenAI] ERROR`, err?.message || err);
    if (twilioOpen) twilioWS.close();
  });

  aiWS.on("close", () => {
    log(`[${callId}] [OpenAI] WS closed`);
    if (twilioOpen) twilioWS.close();
  });

  // 3) Forward OpenAI audio chunks to Twilio
  aiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // We only care about audio chunks for talk-only
      if (msg.type === "response.audio.delta" && msg.delta) {
        // msg.delta is base64 μ-law (g711_ulaw) already
        if (twilioOpen && twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({
            event: "media",
            media: { payload: msg.delta }
          }));
        }
      } else if (msg.type === "response.completed") {
        // When TTS finishes, you can hang up or keep the stream open.
        // For now, just end after talk demo:
        setTimeout(() => closeBoth("talk-finished"), 300);
      }
    } catch (e) {
      log(`[${callId}] [OpenAI] parse error`, e?.message || e);
    }
  });

  // 4) Twilio WS handlers
  twilioWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Twilio sends keepalives; reply with pong
      if (msg.event === "start") {
        log(`[${callId}] [twilio] start`);
      } else if (msg.event === "connected") {
        log(`[${callId}] [twilio] connected`);
      } else if (msg.event === "media") {
        // IGNORE inbound mic frames for now (talk-only)
      } else if (msg.event === "stop") {
        log(`[${callId}] [twilio] stop`);
        closeBoth("twilio-stop");
      }
    } catch (e) {
      log(`[${callId}] [twilio] parse error`, e?.message || e);
    }
  });

  twilioWS.on("close", () => {
    twilioOpen = false;
    log(`[${callId}] [twilio] WS closed`);
    if (aiOpen) aiWS.close();
  });

  twilioWS.on("error", (err) => {
    log(`[${callId}] [twilio] ERROR`, err?.message || err);
    if (aiOpen) aiWS.close();
  });
});

// Health + logs hint
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("==>");
  console.log(`==> Available at your primary URL https://barber-ai.onrender.com`);
  console.log("==>");
  console.log("==> //////////////////////////////////////////////////////////////");
});
