// server.js — Twilio <-> OpenAI Realtime (g711 μ-law) telephony bridge
// Requirements:
//   - TWILIO calls point to:  wss://<your-app>/media  (you already set this in TwiML)
//   - OPENAI_API_KEY in env

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

// ============================
// Config
// ============================
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Commit at least 100ms of μ-law audio each time to avoid "buffer too small"
const COMMIT_MS = 120;           // a little over 100ms is fine
const SAMPLE_RATE = 8000;        // μ-law 8kHz
const BYTES_PER_MS = SAMPLE_RATE / 1000; // 8 bytes/ms for μ-law (1 byte per sample)
const MIN_BYTES_PER_COMMIT = Math.ceil(BYTES_PER_MS * COMMIT_MS); // ~960 bytes at 120ms

// ============================
// App + WS server
// ============================
const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ============================
// Helper
// ============================
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

function b64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
}

function joinBuffers(buffers) {
  if (!buffers.length) return Buffer.alloc(0);
  return Buffer.concat(buffers, buffers.reduce((n, b) => n + b.length, 0));
}

// ============================
// Twilio <-> OpenAI bridge
// ============================
wss.on("connection", (twilioWS) => {
  let streamSid = null;

  // buffer incoming Twilio μ-law frames and flush >=100ms
  let inboundChunks = [];
  let lastFlush = Date.now();

  // OpenAI Realtime client (WebSocket)
  const { WebSocket } = require("ws");
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Forward a chunk of μ-law audio from OpenAI -> Twilio
  function sendToTwilioUlaw(base64Payload) {
    if (twilioWS.readyState !== twilioWS.OPEN || !streamSid) return;
    safeSend(twilioWS, {
      event: "media",
      streamSid,
      media: { payload: base64Payload },
    });
  }

  // Periodically flush inbound μ-law to OpenAI with >=100ms
  const flushTimer = setInterval(() => {
    if (oaWS.readyState !== oaWS.OPEN) return;
    const now = Date.now();
    const elapsed = now - lastFlush;
    const totalBytes = inboundChunks.reduce((n, b) => n + b.length, 0);
    if (elapsed >= COMMIT_MS && totalBytes >= MIN_BYTES_PER_COMMIT) {
      const buf = joinBuffers(inboundChunks);
      inboundChunks = [];
      lastFlush = now;

      // Append μ-law audio to OpenAI buffer
      oaWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: b64(buf),
        // format defaults to the session's input_audio_format (we set below)
      }));
      // Then commit so the model can process it
      oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  }, Math.max(20, COMMIT_MS / 2));

  // ---- Twilio WS ----
  twilioWS.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    const { event } = data;

    if (event === "start") {
      streamSid = data.start?.streamSid || data.streamSid;
      console.log("[Twilio] START", { streamSid });
      return;
    }

    if (event === "media") {
      // Collect 20ms μ-law frames
      const payload = data.media?.payload;
      if (payload) inboundChunks.push(Buffer.from(payload, "base64"));
      return;
    }

    if (event === "stop") {
      console.log("[Twilio] STOP", { streamSid: data.stop?.streamSid || streamSid });
      try { twilioWS.close(1000); } catch (_) {}
      try { oaWS.close(1000); } catch (_) {}
      return;
    }
  });

  twilioWS.on("close", () => {
    clearInterval(flushTimer);
    try { oaWS.close(1000); } catch (_) {}
  });
  twilioWS.on("error", (err) => console.error("[Twilio] WS error", err));

  // keep-alive mark
  const markTimer = setInterval(() => {
    if (twilioWS.readyState === twilioWS.OPEN && streamSid) {
      safeSend(twilioWS, { event: "mark", streamSid, mark: { name: "alive" } });
    }
  }, 5000);

  twilioWS.on("close", () => clearInterval(markTimer));

  // ---- OpenAI WS ----
  oaWS.on("open", () => {
    console.log("[OpenAI] WS open");

    // Configure the session for μ-law in *and* out + voice + system instructions
    oaWS.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "verse", // pick any real-time voice
        instructions:
          "You are a friendly barber shop assistant. Answer briefly, and ask helpful follow-up questions when appropriate.",
      },
    }));

    // Send an immediate greeting as audio so caller hears something right away
    oaWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hi! Thanks for calling the barbershop, how can I help you today?",
        audio: { voice: "verse" },
      },
    }));
  });

  oaWS.on("message", (raw) => {
    // OpenAI sends many event types; handle audio bytes
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // The Realtime API may stream as response.output_audio.delta
    // (older fields like output_audio_buffer.append also exist).
    const t = evt.type;

    if (t === "response.output_audio.delta" && evt.delta) {
      // evt.delta is base64 payload of μ-law audio
      sendToTwilioUlaw(evt.delta);
      return;
    }

    if (t === "output_audio_buffer.append" && evt.audio) {
      sendToTwilioUlaw(evt.audio);
      return;
    }

    if (t === "response.completed") {
      // Can trigger another response if desired
      return;
    }

    if (t === "error") {
      console.error("[OpenAI ERROR]", evt);
      return;
    }
  });

  oaWS.on("error", (err) => console.error("[OpenAI] WS error", err));
  oaWS.on("close", (code, reason) => {
    console.log("[OpenAI] WS closed", code, reason?.toString());
    try { twilioWS.close(1000); } catch (_) {}
  });
});

// ============================
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
