/** src/server.js - Minimal Twilio <-> OpenAI Realtime bridge (μ-law, inbound-only) */
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const cors = require("cors");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

/* -------------------------- env & constants -------------------------- */
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

/* Basic guard */
if (!OPENAI_API_KEY) {
  console.error("!! Missing OPENAI_API_KEY in your environment.");
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* health */
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

/* optional: Twilio status callback */
app.post("/twilio-status", (req, _res) => {
  try {
    console.log("Twilio status callback body:", JSON.stringify(req.body, null, 2));
  } catch {}
  _res.sendStatus(200);
});

/* ---------------------- Twilio <Stream> WebSocket --------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

/**
 * Utility: make an OpenAI Realtime WS connection.
 */
function makeOpenAIRealtime() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
  return ws;
}

/**
 * Twilio upgrades to /twilio for media streaming.
 */
server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (!url || !url.startsWith("/twilio")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (twilioWS, req) => {
  const connId = crypto.randomBytes(3).toString("hex");
  console.log(`[${connId}] WS CONNECTED on /twilio from ${req.socket.remoteAddress}`);

  let openaiWS = null;
  let openaiReady = false;
  let haveStartedResponse = false;

  // Buffer of Twilio audio packets (20ms each). We’ll commit after 5 packets (>=100ms)
  let packetBuffer = [];
  const PACKETS_PER_COMMIT = 5;

  /* ---- connect to OpenAI after Twilio connects ---- */
  openaiWS = makeOpenAIRealtime();

  openaiWS.on("open", () => {
    openaiReady = true;
    console.log(`[${connId}] OpenAI WS open`);

    // Tell OpenAI about audio formats and that we want both audio + text back.
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Twilio sends μ-law 8kHz mono
        input_audio_format: "g711_ulaw",
        // Ask OpenAI to reply with audio and text; audio in μ-law so we can pass through.
        response: {
          modalities: ["audio", "text"],
          instructions: "You are a concise voice assistant. Keep replies short and friendly.",
          // Many SDKs accept one of these; this is the current accepted key for Realtime v1:
          output_audio_format: "g711_ulaw",
          // voice options vary by model; 'verse' works commonly
          voice: "verse",
        },
      },
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
  });

  openaiWS.on("message", (data) => {
    // OpenAI sends JSON events and (for audio) "response.audio.delta" with base64 frames
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "response.created") {
      console.log(`[${connId}] OpenAI: response.created`);
    } else if (msg.type === "response.output_text.delta") {
      // Optional text delta logs
      // console.log(`[${connId}] text.delta:`, msg.delta);
    } else if (msg.type === "response.completed") {
      console.log(`[${connId}] OpenAI: response.completed`);
      haveStartedResponse = false; // allow next response
    } else if (msg.type === "error") {
      console.error(`[${connId}] OpenAI ERROR:`, JSON.stringify(msg, null, 2));
    } else if (msg.type === "response.audio.delta") {
      // This should be g711_ulaw base64 if the model supports it.
      const base64uLaw = msg.delta; // base64 bytes for μ-law audio
      if (base64uLaw && twilioWS.readyState === WebSocket.OPEN) {
        // Send to Twilio for playback
        const mediaMsg = {
          event: "media",
          media: { payload: base64uLaw },
        };
        twilioWS.send(JSON.stringify(mediaMsg));
      }
    }
  });

  openaiWS.on("close", (code, reason) => {
    console.log(`[${connId}] OpenAI WS closed`, code, reason?.toString() || "");
    openaiReady = false;
  });

  openaiWS.on("error", (err) => {
    console.error(`[${connId}] OpenAI WS error`, err);
  });

  /* ---- Twilio incoming messages ---- */
  twilioWS.on("message", (msg) => {
    let payload;
    try {
      payload = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const { event } = payload;

    if (event === "connected") {
      console.log(`[${connId}] Twilio event: connected`);
    }

    if (event === "start") {
      const { streamSid, tracks, mediaFormat, customParameters } = payload.start || {};
      console.log(
        `[${connId}] media START`,
        JSON.stringify({ streamSid, tracks, mediaFormat, customParameters }, null, 2)
      );
    }

    if (event === "media") {
      // Each payload is 20ms μ-law 8kHz mono base64
      const chunk = payload.media?.payload;
      if (!chunk) return;

      // Forward to OpenAI as input frames (append), but only when OpenAI is ready
      if (openaiReady && openaiWS?.readyState === WebSocket.OPEN) {
        packetBuffer.push(chunk);

        // Append every 20ms packet as a separate append event
        // We could also join to one big base64; OpenAI accepts multiple appends before commit.
        openaiWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: chunk, // base64 μ-law
          })
        );

        // Commit every >=100ms (5 packets) to avoid "buffer too small" error
        if (packetBuffer.length >= PACKETS_PER_COMMIT) {
          packetBuffer = [];
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

          // After the first commit, ask OpenAI to respond once.
          if (!haveStartedResponse) {
            haveStartedResponse = true;
            openaiWS.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  // Keep it simple for now; model may also use the live audio buffer contents
                  instructions: "Greet the caller briefly and ask how you can help.",
                },
              })
            );
          }
        }
      }
    }

    if (event === "stop") {
      const streamSid = payload.streamSid;
      console.log(`[${connId}] media STOP ${streamSid}`);
    }
  });

  twilioWS.on("close", () => {
    console.log(`[${connId}] Twilio WS closed`);
    try {
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) openaiWS.close();
    } catch {}
  });

  twilioWS.on("error", (err) => {
    console.error(`[${connId}] Twilio WS error`, err);
  });
});

/* ------------------------------- start ------------------------------- */
server.listen(PORT, () => {
  console.log("////////////////////////////////////////////////////");
  console.log(`=> Server listening on ${PORT}`);
  console.log("=> Your service is live 🎉");
  console.log("=> ");
  console.log(`=> Available at your primary URL https://barber-ai.onrender.com`);
  console.log("////////////////////////////////////////////////////");
});
