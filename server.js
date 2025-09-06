// server.js — Twilio <-> OpenAI Realtime bridge (CommonJS, μ-law 8kHz)
// Note: NO dotenv import is used; Render provides env vars automatically.

const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

// ---- Environment ----
const PORT = process.env.PORT || 10000;
const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL || "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // set in Render dashboard

// ---- Basic server ----
const app = express();
app.use(cors());
app.use(bodyParser.json());

const server = http.createServer(app);

// Health
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Optional: Twilio status callback (helps us get logs when Twilio starts/stops)
app.post("/twilio-status", (req, res) => {
  console.info("Twilio status callback body:", req.body);
  res.sendStatus(200);
});

// Twilio Media Streams connects here (TwiML <Stream url="wss://.../twilio" track="both_tracks" />)
const wss = new WebSocket.Server({ server, path: "/twilio" });

/**
 * Twilio media stream messages look like JSON events:
 * - "start"    (streamSid, etc.)
 * - "media"    (payload: base64 μ-law frames, 20ms @ 8kHz)
 * - "stop"
 *
 * We forward μ-law audio -> OpenAI Realtime, and play TTS audio back to Twilio as μ-law.
 */
wss.on("connection", (twilioWS, req) => {
  console.info("WS CONNECTED on /twilio from:", req.socket.remoteAddress || "::1");

  // Create a socket to OpenAI Realtime
  const openaiWS = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let streamSid = null;

  // Helper: send to OpenAI safely
  const sendOpenAI = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };

  // Helper: send to Twilio safely
  const sendTwilio = (obj) => {
    if (twilioWS && twilioWS.readyState === WebSocket.OPEN) {
      twilioWS.send(JSON.stringify(obj));
    }
  };

  // When OpenAI socket opens, configure the session for μ-law and audio+text
  openaiWS.on("open", () => {
    console.info("OpenAI WS open");

    // Configure session: ulaw in/out @ 8kHz, audio+text responses
    sendOpenAI({
      type: "session.update",
      session: {
        input_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 },
        modalities: ["audio", "text"],
        // responses should include audio by default
        response: { modalities: ["audio", "text"], conversation: "auto" },
        // choose any available voice; keep simple
        voice: "verse",
      },
    });

    // Give a short greeting so we can hear something immediately
    sendOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hello! I’m connected and listening.",
      },
    });
  });

  openaiWS.on("error", (err) => {
    console.error("[OpenAI] socket error:", err);
  });

  openaiWS.on("close", () => {
    console.info("OpenAI WS closed");
    try { twilioWS.close(); } catch (_) {}
  });

  // Messages FROM OpenAI -> to Twilio
  openaiWS.on("message", (data) => {
    // Realtime may send JSON events AND/OR binary audio frames.
    // The SDK sends audio frames as base64 inside JSON with type 'response.audio.delta'
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      // Not JSON; ignore (or handle if using a different format)
      return;
    }

    if (msg.type === "response.audio.delta" && msg.audio) {
      // msg.audio is base64 μ-law audio @8kHz. Twilio expects "media" -> payload (base64 μ-law)
      sendTwilio({
        event: "media",
        streamSid: streamSid || undefined,
        media: { payload: msg.audio },
      });
    } else if (msg.type === "response.completed") {
      // Nothing special to do; next audio will come as deltas above
    } else if (msg.type === "error") {
      console.error("[OpenAI ERROR]:", msg);
    }
  });

  // Messages FROM Twilio -> to OpenAI
  twilioWS.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.event === "start") {
      streamSid = evt.start.streamSid;
      console.info("Twilio start, streamSid:", streamSid);
      return;
    }

    if (evt.event === "media" && evt.media && evt.media.payload) {
      // Forward μ-law base64 frame to OpenAI input buffer
      sendOpenAI({
        type: "input_audio_buffer.append",
        audio: evt.media.payload, // base64 μ-law
      });
      // IMPORTANT: commit after each 20–40ms of audio so OpenAI processes it.
      sendOpenAI({ type: "input_audio_buffer.commit" });
      return;
    }

    if (evt.event === "stop") {
      console.info("Twilio stop");
      try { openaiWS.close(); } catch (_) {}
      return;
    }
  });

  twilioWS.on("close", () => {
    console.info("Twilio WS closed");
    try { openaiWS.close(); } catch (_) {}
  });

  twilioWS.on("error", (err) => {
    console.error("[Twilio] socket error:", err);
    try { openaiWS.close(); } catch (_) {}
  });
});

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
  console.log("////////////////////////////////////////////////////");
  console.log("Available at your primary URL https://barber-ai.onrender.com");
  console.log("////////////////////////////////////////////////////");
});
