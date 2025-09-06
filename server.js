// server.js  — CommonJS
// Minimal Twilio <-> OpenAI Realtime bridge using µ-law (G.711 ulaw) at 8kHz

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in env");
  process.exit(1);
}

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

const app = express();
app.use(express.json());

// (optional) Twilio status callback so you can see stream errors in Render logs
app.post("/twilio-status", (req, res) => {
  console.log("Twilio status callback body:", req.body);
  res.sendStatus(204);
});

const server = http.createServer(app);

// WebSocket endpoint Twilio streams will connect to
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWS, req) => {
  console.log("==> HTTP UPGRADE from Twilio OK");

  // Open a Realtime WS to OpenAI only AFTER Twilio connects
  const openaiWS = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Store the current Twilio streamSid to echo audio back
  let streamSid = null;

  // Buffer for 100ms of audio (Twilio sends 20ms frames)
  let pendingAudio = [];
  let frameCount = 0;

  const flushAudioToOpenAI = () => {
    if (frameCount === 0) return;
    // Append each 20ms ulaw chunk to OpenAI
    for (const b64 of pendingAudio) {
      openaiWS.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: b64, // already base64 µ-law from Twilio
        })
      );
    }
    // Commit once we have ~100ms
    openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    pendingAudio = [];
    frameCount = 0;
  };

  openaiWS.on("open", () => {
    console.log("==> OpenAI WS open");

    // Configure the session once (VALID fields only)
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          // Bot voice and instruction
          voice: "alloy",
          instructions:
            "You are a friendly phone assistant. Keep replies brief and conversational.",

          // We want both audio and text available
          modalities: ["audio", "text"],

          // Twilio sends G.711 µ-law at 8kHz mono
          input_audio_format: { type: "g711_ulaw", sample_rate: 8000 },

          // Ask OpenAI to return µ-law at 8kHz so we can stream back to Twilio
          output_audio_format: { type: "g711_ulaw", sample_rate: 8000 },

          // Simple server-side VAD so it replies after you stop speaking
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      })
    );

    // Send a quick greeting so you hear something immediately
    openaiWS.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Hi! I’m here. How can I help?",
        },
      })
    );
  });

  openaiWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());
      // Stream back audio as it is produced
      if (evt.type === "output_audio.delta" && evt.delta && streamSid) {
        // Send a Twilio media message. Payload is base64 µ-law from OpenAI.
        const twilioMediaMsg = {
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        };
        twilioWS.send(JSON.stringify(twilioMediaMsg));
      }

      // When a response is fully done, you could log it
      if (evt.type === "response.completed") {
        console.log("[OpenAI] response.completed id:", evt.response?.id);
      }

      // Log errors from OpenAI clearly
      if (evt.type === "error") {
        console.error("[OpenAI ERROR]:", JSON.stringify(evt, null, 2));
      }
    } catch (e) {
      console.error("Error parsing OpenAI message:", e);
    }
  });

  openaiWS.on("close", () => {
    console.log("==> OpenAI WS closed");
  });
  openaiWS.on("error", (err) => {
    console.error("==> OpenAI WS error:", err);
  });

  // Handle Twilio WS messages
  twilioWS.on("message", (msg) => {
    let parsed;
    try {
      parsed = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const { event } = parsed;

    if (event === "start") {
      streamSid = parsed.start?.streamSid;
      console.log("[Twilio] START, streamSid:", streamSid);
      return;
    }

    if (event === "media") {
      // Twilio 20ms µ-law frame in base64 at media.payload
      const payload = parsed.media?.payload;
      if (!payload) return;

      // Buffer until we have ~100ms, then flush to OpenAI
      pendingAudio.push(payload);
      frameCount += 1;
      if (frameCount >= 5) flushAudioToOpenAI();
      return;
    }

    if (event === "mark") return;

    if (event === "stop") {
      console.log("[Twilio] STOP");
      // Flush anything left
      flushAudioToOpenAI();
      // End the current input turn (so the model answers)
      openaiWS.send(JSON.stringify({ type: "response.create", response: {} }));
      return;
    }
  });

  twilioWS.on("close", () => {
    console.log("==> Twilio WS closed");
    try {
      flushAudioToOpenAI();
    } catch {}
    try {
      openaiWS.close();
    } catch {}
  });

  twilioWS.on("error", (err) => {
    console.error("==> Twilio WS error:", err);
  });
});

server.listen(PORT, () => {
  console.log("/////////////////////////////////////////////////");
  console.log(`Available at your primary URL https://barber-ai.onrender.com`);
  console.log("/////////////////////////////////////////////////");
});
