// src/server.js
// Minimal Twilio <-> OpenAI Realtime bridge (g711_ulaw, 100ms batching)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in env");
  process.exit(1);
}

const app = express();
app.use(express.json());

// Optional status callback for Twilio Stream (helps debugging)
app.post("/twilio-status", (req, res) => {
  console.log("Twilio status callback body:", req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("OK"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ---- Helpers ---------------------------------------------------------------

function sendTwilio(ws, event) {
  try {
    ws.send(JSON.stringify(event));
  } catch (_) {}
}

function sendOpenAI(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (_) {}
}

// ---- Upgrade handler for /twilio ------------------------------------------

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/twilio")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ---- Twilio <-> OpenAI bridge per call ------------------------------------

wss.on("connection", (twilioWS) => {
  console.log("//// CONNECTED from Twilio OK");

  let streamSid = null;
  let openaiWS = null;

  // Batch 5 x 20ms = 100ms (ulaw @ 8kHz mono 1 byte/sample => 800 bytes)
  const TARGET_BATCH_BYTES = 800;
  let batchChunks = [];
  let batchBytes = 0;

  const flushBatchToOpenAI = () => {
    if (!openaiWS || openaiWS.readyState !== WebSocket.OPEN) return;
    if (batchBytes <= 0) return;

    const buf = Buffer.concat(batchChunks, batchBytes);
    const base64 = buf.toString("base64");
    sendOpenAI(openaiWS, { type: "input_audio_buffer.append", audio: base64 });
    sendOpenAI(openaiWS, { type: "input_audio_buffer.commit" });

    batchChunks = [];
    batchBytes = 0;
  };

  const openOpenAI = () => {
    if (openaiWS) return;

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
    openaiWS = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWS.on("open", () => {
      console.log("OpenAI WS open");

      // Make sure formats are μ-law in and out, and only audio output
      sendOpenAI(openaiWS, {
        type: "session.update",
        session: {
          modalities: ["audio"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "none" },
          voice: "verse",
        },
      });

      // Say something so we can hear it right away
      sendOpenAI(openaiWS, {
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "Hello! I'm connected.",
        },
      });
    });

    openaiWS.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Forward audio deltas back to Twilio as media frames
      if (msg.type === "output_audio_buffer.delta" && msg.delta && streamSid) {
        sendTwilio(twilioWS, {
          event: "media",
          streamSid,
          media: { payload: msg.delta }, // already base64 g711_ulaw
        });
      }

      // When each message/utterance is done, tell Twilio to flush the sink
      if (msg.type === "response.completed" && streamSid) {
        sendTwilio(twilioWS, { event: "mark", streamSid, mark: { name: "ai_response_done" } });
      }

      if (msg.type === "error") {
        console.error("OpenAI ERROR:", msg);
      }
    });

    openaiWS.on("close", () => console.log("OpenAI WS closed"));
    openaiWS.on("error", (err) => console.error("OpenAI WS error:", err));
  };

  twilioWS.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const { event } = msg;

    if (event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("Twilio start, streamSid:", streamSid);

      // Tell Twilio we want both inbound & outbound (already set in TwiML)
      openOpenAI();
      return;
    }

    if (event === "media") {
      // Twilio audio chunk g711_ulaw base64 → accumulate
      const b = Buffer.from(msg.media.payload, "base64");
      batchChunks.push(b);
      batchBytes += b.length;

      if (batchBytes >= TARGET_BATCH_BYTES) {
        flushBatchToOpenAI();
      }
      return;
    }

    if (event === "stop") {
      console.log("Twilio stop");
      flushBatchToOpenAI();
      try { openaiWS && openaiWS.close(); } catch {}
      return;
    }
  });

  twilioWS.on("close", () => {
    console.log("Twilio WS closed");
    try { openaiWS && openaiWS.close(); } catch {}
  });

  twilioWS.on("error", (err) => {
    console.error("Twilio WS error:", err);
    try { openaiWS && openaiWS.close(); } catch {}
  });
});

// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
  console.log("Your service is live 🎉");
  console.log("Available at your primary URL https://barber-ai.onrender.com");
});
