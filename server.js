// server.js  (CommonJS)
// Minimal Twilio <-> OpenAI Realtime bridge with μ-law pass-through and safe buffering.

const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const cors = require("cors");

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const OPENAI_VOICE = process.env.POLLY_VOICE ? "alloy" : "alloy"; // any supported voice

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Optional: Twilio status callbacks (handy for debugging if you wire it in the TwiML)
app.post("/twilio-status", (req, res) => {
  console.log("Twilio status callback body:", req.body);
  res.sendStatus(200);
});

const server = http.createServer(app);

/** WebSocket entry for Twilio Media Streams */
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTwilioStream(ws, req).catch((err) => {
        console.error("Fatal error in Twilio handler:", err);
        try {
          ws.close();
        } catch {}
      });
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log("/////////////////////////////////////////////////");
  console.log(`Available at your primary URL https://barber-ai.onrender.com`);
  console.log("/////////////////////////////////////////////////");
  console.log(`Server listening on ${PORT}`);
});

/** Core bridge logic */
async function handleTwilioStream(twilioWS /* WebSocket */, req) {
  const ctx = mkCtx(); // simple per-call tag for logs
  log(ctx, "WS CONNECTED on /twilio from", req.socket.remoteAddress);

  // ====== OpenAI Realtime WS =================================================
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let oaiOpen = false;
  let twilioOpen = true;

  // Buffer Twilio μ-law audio frames and commit every ≥100ms (we use ~200ms).
  // Twilio sends 20ms @ 8kHz per frame (160 bytes μ-law). We’ll wait for ≥10 frames.
  const TWILIO_FRAME_MS = 20;
  const COMMIT_MS = 200; // ≥100ms required by API; 200ms is comfortable
  const FRAMES_PER_COMMIT = Math.ceil(COMMIT_MS / TWILIO_FRAME_MS); // 10

  let pendingFrames = [];
  let commitTimer = null;

  function startCommitTimer() {
    if (commitTimer) return;
    commitTimer = setInterval(() => {
      if (!oaiOpen) return;
      if (pendingFrames.length === 0) return;

      // Concatenate base64 chunks? The API accepts multiple append events before one commit,
      // so we simply send them individually then send a single commit.
      for (const b64 of pendingFrames) {
        oaiSafeSend(
          {
            type: "input_audio_buffer.append",
            // Twilio payload is already μ-law base64; pass straight through.
            audio: b64,
          },
          "append"
        );
      }
      pendingFrames = [];

      oaiSafeSend({ type: "input_audio_buffer.commit" }, "commit");
    }, COMMIT_MS);
  }

  function stopCommitTimer() {
    if (commitTimer) {
      clearInterval(commitTimer);
      commitTimer = null;
    }
  }

  function cleanup(reason) {
    log(ctx, "cleanup:", reason);
    stopCommitTimer();
    try {
      twilioWS.close();
    } catch {}
    try {
      oaiWS.close();
    } catch {}
  }

  // Helper: Safe send to OpenAI (don’t throw if not open)
  function oaiSafeSend(obj, why = "") {
    if (!oaiOpen || oaiWS.readyState !== WebSocket.OPEN) {
      log(ctx, "skip send (oai not open)", why);
      return;
    }
    try {
      oaiWS.send(JSON.stringify(obj));
    } catch (e) {
      log(ctx, "oai send error:", e.message);
    }
  }

  // Helper: Safe send to Twilio (downlink audio to caller)
  function twilioSafeSend(obj, why = "") {
    if (!twilioOpen || twilioWS.readyState !== WebSocket.OPEN) {
      log(ctx, "skip send (twilio not open)", why);
      return;
    }
    try {
      twilioWS.send(JSON.stringify(obj));
    } catch (e) {
      log(ctx, "twilio send error:", e.message);
    }
  }

  // ----- OpenAI WS events
  oaiWS.on("open", () => {
    oaiOpen = true;
    log(ctx, "OpenAI WS open");

    // Configure session: both input & output μ-law @ 8kHz, voice, modalities
    oaiSafeSend(
      {
        type: "session.update",
        session: {
          // These are *strings* (not objects) — earlier error was due to wrong type
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: OPENAI_VOICE,
        },
      },
      "session.update"
    );

    // Kick off with a small greeting so we know audio is flowing
    oaiSafeSend(
      {
        type: "response.create",
        response: {
          modalities: ["audio", "text"], // ['audio'] alone is invalid
          instructions: "Say: 'Hello — I am connected.'",
        },
      },
      "response.create"
    );

    // Start the periodic commit loop once OAI is open
    startCommitTimer();
  });

  oaiWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());
      // Forward audio deltas to Twilio. Because we requested g711_ulaw output_audio_format,
      // these deltas are already μ-law 8k and can be sent straight back.
      if (evt.type === "response.output_audio.delta" && evt.delta) {
        twilioSafeSend(
          {
            event: "media",
            streamSid: currentStreamSid, // captured from Twilio 'start' event
            media: { payload: evt.delta },
          },
          "downlink-audio"
        );
      }

      // Optional: Log when a response finishes
      if (evt.type === "response.completed") {
        log(ctx, "OpenAI response completed");
      }

      // Also log errors the API sends
      if (evt.type === "error") {
        log(ctx, "OpenAI ERROR:", evt);
      }
    } catch (e) {
      log(ctx, "OpenAI message parse error:", e.message);
    }
  });

  oaiWS.on("close", () => {
    oaiOpen = false;
    log(ctx, "OpenAI WS closed");
    cleanup("oai closed");
  });

  oaiWS.on("error", (err) => {
    log(ctx, "OpenAI WS error:", err.message);
    // don’t crash; cleanup will be triggered by 'close'
  });

  // ====== Twilio WS (incoming audio from caller) =============================
  let currentStreamSid = null;

  twilioWS.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore
    }

    if (msg.event === "connected") {
      log(ctx, "Twilio event: connected");
      return;
    }

    if (msg.event === "start") {
      currentStreamSid = msg.start?.streamSid;
      log(ctx, `media START { streamSid: ${currentStreamSid} }`);
      return;
    }

    if (msg.event === "media") {
      // Inbound μ-law audio from caller (base64)
      const b64 = msg.media?.payload;
      if (typeof b64 === "string" && b64.length > 0) {
        pendingFrames.push(b64);
        // Start the timer if OAI already open; otherwise frames will flush once open
        startCommitTimer();
      }
      return;
    }

    if (msg.event === "stop") {
      log(ctx, "Twilio stop");
      cleanup("twilio stop");
      return;
    }
  });

  twilioWS.on("close", () => {
    twilioOpen = false;
    log(ctx, "Twilio WS closed");
    cleanup("twilio closed");
  });

  twilioWS.on("error", (err) => {
    log(ctx, "Twilio WS error:", err.message);
    // cleanup will be handled by 'close'
  });
}

/** Simple tagged logger for a call */
function mkCtx() {
  const tag = Math.random().toString(36).slice(2, 7);
  return `[${tag}]`;
}
function log(ctx, ...args) {
  console.log(new Date().toLocaleTimeString(), ctx, ...args);
}
