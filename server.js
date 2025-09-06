// server.js — minimal+safe Twilio <-> OpenAI Realtime bridge
// Goals:
// 1) PROVE WS upgrade happens (you'll see "HTTP upgrade for /twilio" then "Twilio WS connected")
// 2) Keep call alive by sending µ-law silence immediately
// 3) Then ask OpenAI to speak "Hello, I'm connected." and forward it
// 4) Survive if OpenAI can't connect (silence keeps Twilio from hanging up)

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("FATAL: OPENAI_API_KEY is not set.");
  process.exit(1);
}

const app = express();
app.use(express.json());

// Just to verify the service is up
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Log Twilio statusCallback (start/error/stop)
app.post("/twilio-status", (req, res) => {
  console.log("Twilio statusCallback:", JSON.stringify(req.body || {}, null, 2));
  res.sendStatus(200);
});

const server = http.createServer(app);

// ---- WS upgrade plumbing ----
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("HTTP upgrade requested for", req.url); // <== IMPORTANT
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---- Utility: send µ-law silence frames (20ms chunks) ----
// Twilio uses 8 kHz, µ-law; 20ms = 160 samples; silence byte is 0xFF
const SILENCE_20MS_BASE64 = Buffer.alloc(160, 0xff).toString("base64");

// Send N * 20ms silence frames back-to-back
function sendSilenceFrames(ws, n = 10) {
  for (let i = 0; i < n; i++) {
    const frame = { event: "media", media: { payload: SILENCE_20MS_BASE64 } };
    try {
      ws.send(JSON.stringify(frame));
    } catch (e) {
      console.error("Error sending silence to Twilio:", e.message);
      return;
    }
  }
}

// ---- Main connection handler ----
wss.on("connection", (twilioWS) => {
  const tag = Math.random().toString(36).slice(2, 7);
  console.log(`[${tag}] Twilio WS connected`);

  let openaiWS = null;

  // Immediately start a silence ticker (keeps call open even if OpenAI is slow)
  const silenceInterval = setInterval(() => {
    sendSilenceFrames(twilioWS, 5); // 100ms of silence every tick
  }, 100);

  // Helper to clean up
  const tidy = () => {
    clearInterval(silenceInterval);
    try { openaiWS?.close(); } catch {}
    try { twilioWS?.close(); } catch {}
  };

  // Open OpenAI Realtime WS
  const openaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_REALTIME_MODEL
  )}`;
  console.log(`[${tag}] Connecting to OpenAI WS…`);
  openaiWS = new WebSocket(openaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWS.on("open", () => {
    console.log(`[${tag}] OpenAI WS open`);

    // Configure session for µ-law at 8 kHz, audio-only
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio"],
        input_audio_format: "g711_ulaw",
        response: {
          modalities: ["audio"],
          audio: { format: "g711_ulaw", sample_rate: 8000 },
        },
        turn_detection: null,
      },
    };
    openaiWS.send(JSON.stringify(sessionUpdate));

    // Ask OpenAI to speak something short
    const sayHello = {
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hello, I'm connected.",
      },
    };
    openaiWS.send(JSON.stringify(sayHello));
    console.log(`[${tag}] Requested greeting from OpenAI`);
  });

  // Forward OpenAI audio deltas to Twilio
  openaiWS.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return; // ignore binary or unknown
    }

    if (msg.type === "response.output_audio.delta" && msg.delta) {
      const frame = { event: "media", media: { payload: msg.delta } };
      try {
        twilioWS.send(JSON.stringify(frame));
      } catch (e) {
        console.error(`[${tag}] Error sending OpenAI audio to Twilio:`, e.message);
      }
    }

    if (msg.type === "response.completed") {
      console.log(`[${tag}] OpenAI response completed`);
    }

    if (msg.type === "error") {
      console.error(`[${tag}] OpenAI ERROR:`, JSON.stringify(msg, null, 2));
    }
  });

  openaiWS.on("close", (code, reason) => {
    console.log(`[${tag}] OpenAI WS closed:`, code, reason?.toString());
  });
  openaiWS.on("error", (err) => {
    console.error(`[${tag}] OpenAI WS error:`, err.message);
  });

  // Twilio inbound WS messages (we only log start/stop for this test)
  twilioWS.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.event === "start") {
      console.log(
        `[${tag}] Twilio start: streamSid=${msg.start?.streamSid} from=${msg.start?.from}`
      );
    } else if (msg.event === "stop") {
      console.log(`[${tag}] Twilio stop`);
      tidy();
    }
  });

  twilioWS.on("close", () => {
    console.log(`[${tag}] Twilio WS closed`);
    tidy();
  });
  twilioWS.on("error", (err) => {
    console.error(`[${tag}] Twilio WS error:`, err.message);
    tidy();
  });
});

// ---- Boot ----
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log("=> Your service is live 🚀");
  console.log("=> ///////////////////////////////////////////////");
  console.log("=> Available at your primary URL https://barber-ai.onrender.com");
  console.log("=> ///////////////////////////////////////////////");
});
