// server.js — adds /twilio-status logging so we see Twilio errors even if WS never opens
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => res.status(200).send("OK"));

// Twilio Stream status callback -> we will ALWAYS see logs here if Twilio tries to stream
app.post("/twilio-status", (req, res) => {
  console.log("[Twilio StatusCallback] body:", req.body);
  res.sendStatus(200);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio" });

// ====== Minimal talk-only bridge (same as you had, trimmed a bit) ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "alloy";

const b64ToBytes = (b64) => Buffer.from(b64, "base64");
const bytesToB64 = (buf) => Buffer.from(buf).toString("base64");

wss.on("connection", (twilioWs, req) => {
  console.log("WS CONNECTED on /twilio from", req.socket.remoteAddress);

  let openaiWs = null;
  let buffer = Buffer.alloc(0);
  let openaiReady = false;

  const safeCloseOpenAI = () => {
    try { openaiWs && openaiWs.readyState === WebSocket.OPEN && openaiWs.close(); } catch {}
  };

  twilioWs.on("close", () => {
    console.log("[Twilio] WS closed");
    safeCloseOpenAI();
  });
  twilioWs.on("error", (e) => console.error("[Twilio] WS error", e));

  const attachOpenAI = () => {
    if (!OPENAI_API_KEY) {
      console.warn("[WARN] OPENAI_API_KEY missing; skipping OpenAI connect.");
      return;
    }
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
    console.log("[OpenAI] Connecting to", url);
    openaiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWs.on("open", () => {
      openaiReady = true;
      console.log("[OpenAI] WS open — configuring session & greeting");
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format:  { type: "g711_ulaw", channels: 1, sample_rate: 8000 },
          output_audio_format: { type: "g711_ulaw", channels: 1, sample_rate: 8000 },
          voice: VOICE,
          turn_detection: { type: "server_vad" }
        }
      }));
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"], instructions: "Give a short hello." }
      }));
    });

    openaiWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "error") return console.error("[OpenAI ERROR]", msg);
        if (msg.type === "output_audio.delta" && msg.audio && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: "media", media: { payload: msg.audio } }));
        }
      } catch (e) { console.error("OpenAI parse error:", e); }
    });

    openaiWs.on("close", (c, r) => { openaiReady = false; console.log("[OpenAI] WS closed", c, r?.toString()); });
    openaiWs.on("error", (e) => console.error("[OpenAI] WS error", e));
  };

  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.event === "connected") console.log("Twilio event: connected");
      if (data.event === "start") { console.log("Twilio START:", data.start); attachOpenAI(); }
      if (data.event === "media" && openaiReady) {
        const chunk = b64ToBytes(data.media.payload);
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= 800) { // ~100ms at 8k ulaw
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToB64(buffer) }));
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          buffer = Buffer.alloc(0);
        }
      }
      if (data.event === "stop") { console.log("Twilio STOP"); safeCloseOpenAI(); }
    } catch (e) { console.error("Twilio parse error:", e); }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server listening on", PORT));
