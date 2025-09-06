// server.js  — minimal Realtime bridge (OpenAI -> Twilio), g711_ulaw @ 8000 Hz.
// ES module style to match Render's "type":"module" environments.

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ---- Config (env) ----
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // required
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Basic checks
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set.");
  process.exit(1);
}

// ---- Express app ----
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).send("ok"));

// Simple log endpoint for Twilio <Stream statusCallback>
app.post("/twilio-status", (req, res) => {
  console.log("Twilio statusCallback:", JSON.stringify(req.body || {}, null, 2));
  res.sendStatus(200);
});

const server = http.createServer(app);

// ---- WebSocket upgrade for Twilio Media Streams ----
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---- Connection handler: Twilio <-> OpenAI (outbound only) ----
wss.on("connection", (twilioWS) => {
  const tag = Math.random().toString(36).slice(2, 7);
  console.log(`[${tag}] Twilio WS connected.`);

  let openaiWS;
  let openaiReady = false;

  // 1) Open OpenAI Realtime WS
  const openaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_REALTIME_MODEL
  )}`;
  openaiWS = new WebSocket(openaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWS.on("open", () => {
    console.log(`[${tag}] OpenAI WS open.`);

    // 2) Configure the session for ulaw @ 8k and audio-only responses
    const sessionUpdate = {
      type: "session.update",
      session: {
        // No fancy voice name here; we just want audio bytes back
        modalities: ["audio"],
        input_audio_format: "g711_ulaw",
        response: {
          modalities: ["audio"],
          audio: { format: "g711_ulaw", sample_rate: 8000 },
        },
        // Turn detection off for now; we’re only sending a fixed greeting back
        turn_detection: null,
      },
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
    openaiReady = true;

    // 3) Ask OpenAI to speak a quick greeting immediately
    const sayHello = {
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hello, I’m connected.",
      },
    };
    openaiWS.send(JSON.stringify(sayHello));
    console.log(`[${tag}] Requested greeting from OpenAI.`);
  });

  // 4) Forward OpenAI audio deltas to Twilio
  openaiWS.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      // Occasionally OpenAI sends binary packets; ignore here
      return;
    }

    // The current Realtime schema streams audio as "response.output_audio.delta"
    if (msg.type === "response.output_audio.delta" && msg.delta) {
      // msg.delta is base64-encoded ulaw at 8k (we configured it that way)
      const frame = {
        event: "media",
        media: { payload: msg.delta },
      };
      try {
        twilioWS.send(JSON.stringify(frame));
      } catch (e) {
        console.error(`[${tag}] Error sending media to Twilio:`, e.message);
      }
    }

    if (msg.type === "response.completed") {
      console.log(`[${tag}] OpenAI response completed.`);
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

  // 5) Handle Twilio messages (we ignore caller audio for now)
  twilioWS.on("message", (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.event === "start") {
      console.log(
        `[${tag}] Twilio start, streamSid: ${m.start?.streamSid}, from: ${m.start?.callSid || m.start?.from}`
      );
    } else if (m.event === "stop") {
      console.log(`[${tag}] Twilio stop`);
      try {
        openaiWS?.close();
      } catch {}
    }
    // We purposely do NOT forward media from Twilio yet.
  });

  twilioWS.on("close", () => {
    console.log(`[${tag}] Twilio WS closed`);
    try {
      openaiWS?.close();
    } catch {}
  });

  twilioWS.on("error", (err) => {
    console.error(`[${tag}] Twilio WS error:`, err.message);
  });
});

// ---- Start server ----
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log("=> Your service is live 🚀");
  console.log("=> ///////////////////////////////////////////////");
  console.log(
    "=> Available at your primary URL https://barber-ai.onrender.com"
  );
  console.log("=> ///////////////////////////////////////////////");
});
