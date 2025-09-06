// server.js  — minimal Twilio <-> OpenAI Realtime “talk-only” bridge
// Requirements: express, ws, dotenv
//
// ENV needed on Render:
//   OPENAI_API_KEY=sk-...
//   PORT (Render sets this)
// Optional:
//   OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
//   VOICE=alloy

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
app.use(express.json());

// --- Health check
app.get("/", (_req, res) => res.status(200).send("OK"));

// Twilio will WebSocket to:  wss://<host>/twilio
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio" });

// ---------- Helpers
const b64ToBytes = (b64) => Buffer.from(b64, "base64");
const bytesToB64 = (buf) => Buffer.from(buf).toString("base64");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "alloy"; // valid: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marvin, cedar

// Twilio media settings we will use:
//  - sampleRate: 8000
//  - encoding: audio/x-mulaw (G.711 μ-law, 1 byte per sample)
// Twilio sends 20 ms frames (≈160 bytes). We’ll batch to >=100 ms (>=800 bytes) before committing.

wss.on("connection", (twilioWs, req) => {
  console.log("WS CONNECTED on /twilio from", req.socket.remoteAddress);

  // 1) Connect to OpenAI Realtime over WS
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_REALTIME_MODEL
  )}`;

  const openaiWs = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let streamSid = null;
  let buffer = Buffer.alloc(0); // μ-law byte buffer
  let open = false;

  // --- If either side closes, close the other
  const safeClose = () => {
    try { twilioWs.readyState === WebSocket.OPEN && twilioWs.close(); } catch {}
    try { openaiWs.readyState === WebSocket.OPEN && openaiWs.close(); } catch {}
  };

  twilioWs.on("close", () => {
    console.log("[Twilio] WS closed");
    safeClose();
  });
  openaiWs.on("close", () => {
    console.log("[OpenAI] WS closed");
    safeClose();
  });
  twilioWs.on("error", (e) => console.error("[Twilio] WS error", e));
  openaiWs.on("error", (e) => console.error("[OpenAI] WS error", e));

  // --- 2) When OpenAI WS opens, configure audio in/out and voice
  openaiWs.on("open", () => {
    open = true;
    console.log("[OpenAI] WS open");

    // session.update tells OpenAI what audio formats we will send/receive
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Twilio sends μ-law @ 8k mono
        input_audio_format: { type: "g711_ulaw", channels: 1, sample_rate: 8000 },
        // We want μ-law out so we can send straight back to Twilio
        output_audio_format: { type: "g711_ulaw", channels: 1, sample_rate: 8000 },
        voice: VOICE,
        // Let server do VAD so user can just speak; OpenAI will reply when it detects end of turn.
        turn_detection: { type: "server_vad" },
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    // Optional: prime a greeting so we know audio out works
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"], // <- ask for speech
          instructions: "You are a friendly barber shop assistant. Greet the caller briefly.",
        },
      })
    );
  });

  // --- 3) Forward OpenAI audio out -> Twilio <Stream> (media + mark)
  openaiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // audio bytes out come as chunks
      if (msg.type === "output_audio.delta" && msg.audio) {
        // msg.audio is base64 μ-law bytes because we requested g711_ulaw
        twilioWs.readyState === WebSocket.OPEN &&
          twilioWs.send(
            JSON.stringify({ event: "media", media: { payload: msg.audio } })
          );
      }

      if (msg.type === "output_audio.completed") {
        // place a <mark> so Twilio knows segment boundary
        twilioWs.readyState === WebSocket.OPEN &&
          twilioWs.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      }

      if (msg.type === "error") {
        console.error("[OpenAI ERROR]", msg);
      }
    } catch (e) {
      console.error("OpenAI message parse error:", e);
    }
  });

  // --- 4) Handle Twilio media in -> OpenAI input_audio_buffer.append (+commit ≥100ms)
  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === "connected") {
        console.log("Twilio event: connected");
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("Twilio START:", { streamSid, mediaFormat: data.start.mediaFormat });
      }

      if (data.event === "media" && open) {
        // Twilio sends base64 μ-law audio (20 ms frames ≈160 bytes)
        const chunk = b64ToBytes(data.media.payload);
        buffer = Buffer.concat([buffer, chunk]);

        // Commit whenever we have >=100 ms (>=800 bytes) buffered
        if (buffer.length >= 800) {
          const b64 = bytesToB64(buffer);
          // 1) append
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: b64,
            })
          );
          // 2) commit
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          buffer = Buffer.alloc(0);
        }
      }

      if (data.event === "mark") {
        // Twilio asked for a mark ack; nothing to do here for minimal bridge
      }

      if (data.event === "stop") {
        console.log("Twilio STOP:", { streamSid });
        safeClose();
      }
    } catch (e) {
      console.error("Twilio message parse error:", e);
    }
  });
});

// ---------- Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
