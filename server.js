// server.js — safer minimal Twilio <-> OpenAI Realtime talk-only bridge
// Deps: express, ws, dotenv
// ENV: OPENAI_API_KEY (required), OPENAI_REALTIME_MODEL (optional), VOICE (optional)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio" });

const b64ToBytes = (b64) => Buffer.from(b64, "base64");
const bytesToB64 = (buf) => Buffer.from(buf).toString("base64");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "alloy";

// If the key's missing, *never* close Twilio; just log loudly.
if (!OPENAI_API_KEY) {
  console.warn("[BOOT] OPENAI_API_KEY is missing! The call will connect but the AI won't speak.");
}

wss.on("connection", (twilioWs, req) => {
  console.log("WS CONNECTED on /twilio from", req.socket.remoteAddress);

  let openaiWs = null;
  let streamSid = null;
  let buffer = Buffer.alloc(0);
  let openaiReady = false;
  let shuttingDown = false;

  const safeCloseOpenAI = () => {
    try { openaiWs && openaiWs.readyState === WebSocket.OPEN && openaiWs.close(); } catch {}
  };

  const logAndKeepCall = (label, err) => {
    console.error(label, err);
    // Important: do NOT close twilioWs here; keep the call up so we can adjust config
  };

  twilioWs.on("close", () => {
    console.log("[Twilio] WS closed");
    shuttingDown = true;
    safeCloseOpenAI();
  });
  twilioWs.on("error", (e) => {
    console.error("[Twilio] WS error", e);
  });

  // OpenAI message handler (only attached when we open it)
  const attachOpenAIHandlers = () => {
    openaiWs.on("open", () => {
      openaiReady = true;
      console.log("[OpenAI] WS open — configuring session");

      // Configure audio in/out + voice + server VAD
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format:  { type: "g711_ulaw", channels: 1, sample_rate: 8000 },
          output_audio_format: { type: "g711_ulaw", channels: 1, sample_rate: 8000 },
          voice: VOICE,
          turn_detection: { type: "server_vad" }
        }
      }));

      // Send a short greeting once configured (so we know audio-out works)
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "You are a helpful barber shop assistant. Greet the caller briefly."
        }
      }));
    });

    openaiWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "error") {
          // OpenAI protocol errors — keep Twilio up, just log it.
          return logAndKeepCall("[OpenAI ERROR]", msg);
        }

        if (msg.type === "output_audio.delta" && msg.audio) {
          // Send μ-law audio chunk to Twilio
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: "media",
              media: { payload: msg.audio }
            }));
          }
        }

        if (msg.type === "output_audio.completed") {
          // Mark boundary for Twilio; not strictly required but nice to have
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
          }
        }
      } catch (e) {
        logAndKeepCall("OpenAI message parse error:", e);
      }
    });

    openaiWs.on("close", (code, reason) => {
      openaiReady = false;
      console.log("[OpenAI] WS closed", code, reason?.toString());
      // Do NOT close Twilio here; keep the call up so we can see logs and retry if needed.
    });

    openaiWs.on("error", (e) => {
      // Keep call alive; just log the problem
      logAndKeepCall("[OpenAI] WS error", e);
    });
  };

  // Twilio -> events
  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === "connected") {
        console.log("Twilio event: connected");
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("Twilio START:", { streamSid, mediaFormat: data.start.mediaFormat });

        // Only open OpenAI after Twilio start, and only if we have a key
        if (!OPENAI_API_KEY) {
          console.warn("[WARN] No OPENAI_API_KEY; skipping OpenAI connection.");
        } else {
          const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
          console.log("[OpenAI] Connecting to", url);
          try {
            openaiWs = new WebSocket(url, {
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
              },
            });
            attachOpenAIHandlers();
          } catch (e) {
            logAndKeepCall("[OpenAI] Failed to create WS:", e);
          }
        }
      }

      if (data.event === "media") {
        // Buffer 20ms frames until >=100ms (>=800 bytes) then append+commit
        if (openaiReady) {
          const chunk = b64ToBytes(data.media.payload);
          buffer = Buffer.concat([buffer, chunk]);

          if (buffer.length >= 800) {
            const b64 = bytesToB64(buffer);
            try {
              openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
              openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            } catch (e) {
              logAndKeepCall("OpenAI send failed:", e);
            }
            buffer = Buffer.alloc(0);
          }
        }
      }

      if (data.event === "mark") {
        // noop
      }

      if (data.event === "stop") {
        console.log("Twilio STOP:", { streamSid });
        shuttingDown = true;
        // Close OpenAI; let Twilio close naturally
        safeCloseOpenAI();
      }
    } catch (e) {
      logAndKeepCall("Twilio message parse error:", e);
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server listening on", PORT));
