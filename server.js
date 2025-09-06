// Twilio <-> OpenAI Realtime TALK-ONLY bridge with proper μ-law framing & pacing
// - Waits for Twilio "start" before sending
// - OpenAI outputs g711_ulaw (8kHz)
// - We slice to 160-byte frames (20ms) and drip to Twilio every 20ms

const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const PORT = process.env.PORT || 10000;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("OK"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Upgrade -> /media
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Helpers to slice a Buffer into 160-byte μ-law frames
function sliceMuLawFrames(buf) {
  const frames = [];
  const FRAME_SIZE = 160; // 20ms @ 8k Hz in μ-law
  for (let i = 0; i < buf.length; i += FRAME_SIZE) {
    frames.push(buf.subarray(i, Math.min(i + FRAME_SIZE, buf.length)));
  }
  return frames;
}

wss.on("connection", async (twilioWS) => {
  const tag = Math.random().toString(36).slice(2, 6);
  log(`[${tag}] Twilio connected`);

  let twilioOpen = true;
  let twilioReady = false; // set true after Twilio 'start'
  let aiOpen = false;

  // Queue of frames to send to Twilio (each item = Buffer(160))
  const frameQueue = [];
  let dripTimer = null;

  const startDrip = () => {
    if (dripTimer) return;
    dripTimer = setInterval(() => {
      if (!twilioReady || !twilioOpen) return;
      if (frameQueue.length === 0) return;
      const frame = frameQueue.shift();
      try {
        if (twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({
            event: "media",
            media: { payload: frame.toString("base64") }
          }));
        }
      } catch (e) {
        log(`[${tag}] send media error:`, e?.message || e);
      }
    }, 20); // 20ms cadence
  };

  const stopDrip = () => {
    if (dripTimer) {
      clearInterval(dripTimer);
      dripTimer = null;
    }
  };

  // --- Open OpenAI Realtime WS ---
  const aiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const aiWS = new WebSocket(aiURL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  const closeBoth = (why) => {
    try { twilioWS.readyState === WebSocket.OPEN && twilioWS.close(); } catch {}
    try { aiWS.readyState === WebSocket.OPEN && aiWS.close(); } catch {}
    stopDrip();
    log(`[${tag}] closed both (${why})`);
  };

  aiWS.on("open", () => {
    aiOpen = true;
    log(`[${tag}] [OpenAI] WS open`);

    // Set talk-only session: audio out in μ-law
    aiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio"],          // talk-only
        voice: "alloy",                 // valid built-in voice
        output_audio_format: "g711_ulaw"
      }
    }));

    // Ask it to speak immediately
    aiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hi! You're through to the Barber AI test. This is a μ-law framed output test. If you hear me, audio out works."
      }
    }));
  });

  aiWS.on("message", (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    // Debug everything useful
    if (msg.type && msg.type !== "response.audio.delta") {
      log(`[${tag}] [OpenAI] evt:`, msg.type);
      if (msg.type === "error") {
        log(`[${tag}] [OpenAI] ERROR:`, JSON.stringify(msg, null, 2));
      }
    }

    // The audio chunks we want (μ-law)
    if (msg.type === "response.audio.delta" && msg.delta) {
      // Convert base64 -> Buffer, slice into 160-byte frames, push to queue
      const raw = Buffer.from(msg.delta, "base64");
      const frames = sliceMuLawFrames(raw);
      frames.forEach(f => frameQueue.push(f));

      // If Twilio is ready, start dripping
      if (twilioReady) startDrip();
    } else if (msg.type === "response.completed") {
      // after finishing the speak, give a moment & close
      setTimeout(() => closeBoth("ai-finished"), 400);
    }
  });

  aiWS.on("error", (err) => {
    log(`[${tag}] [OpenAI] ERROR`, err?.message || err);
    closeBoth("ai-error");
  });

  aiWS.on("close", () => {
    aiOpen = false;
    log(`[${tag}] [OpenAI] WS closed`);
    if (twilioOpen) {
      twilioWS.close();
    }
  });

  // --- Twilio side ---
  twilioWS.on("message", (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    if (msg.event === "connected") {
      log(`[${tag}] [twilio] connected`);
    } else if (msg.event === "start") {
      log(`[${tag}] [twilio] start`);
      twilioReady = true;
      // If we already buffered frames from AI, start drip now
      startDrip();
    } else if (msg.event === "media") {
      // IGNORE mic input for talk-only
    } else if (msg.event === "stop") {
      log(`[${tag}] [twilio] stop`);
      closeBoth("twilio-stop");
    }
  });

  twilioWS.on("close", () => {
    twilioOpen = false;
    log(`[${tag}] [twilio] WS closed`);
    if (aiOpen) aiWS.close();
    stopDrip();
  });

  twilioWS.on("error", (err) => {
    log(`[${tag}] [twilio] ERROR`, err?.message || err);
    closeBoth("twilio-error");
  });
});

server.listen(PORT, () => {
  console.log("==>");
  console.log(`==> Available at your primary URL https://barber-ai.onrender.com`);
  console.log("==>");
  console.log("==> //////////////////////////////////////////////////////////////");
});
