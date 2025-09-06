// server.js
// Minimal Twilio <-> OpenAI Realtime bridge (TALK-ONLY).
// Twilio hears a greeting. We DO NOT forward caller audio to OpenAI (no echo).

require("dotenv").config?.();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // must be set
const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";

const GREETING =
  "Hi! This is Barber A I. I'm just saying hello right now. Have a great day!";

// -------------- imports
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

// -------------- app + http
const app = express();
app.get("/", (_req, res) => res.status(200).send("OK"));
const server = http.createServer(app);

// -------------- ws endpoint for Twilio
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/media")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ---- helper: send μ-law silence so Twilio doesn't hang up while we wait
function sendUlawSilence(twilioWS, streamSid, msTotal = 400) {
  // μ-law @ 8kHz => 160 samples per 20ms => 160 bytes (each byte is μ-law encoded).
  // Silence in μ-law is 0xFF.
  const frameLenMs = 20;
  const bytesPerFrame = 160;
  const frames = Math.max(1, Math.floor(msTotal / frameLenMs));
  const frame = Buffer.alloc(bytesPerFrame, 0xff); // μ-law silence

  for (let i = 0; i < frames; i++) {
    const payload = frame.toString("base64");
    twilioWS.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload }
      })
    );
  }
}

// -------------- OpenAI <-> Twilio session
wss.on("connection", (twilioWS, req) => {
  console.log("==> Twilio connected");

  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Closing call.");
    twilioWS.close();
    return;
  }

  let streamSid = null;
  let callActive = true;

  // ---- connect to OpenAI realtime
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_MODEL
  )}`;
  const openaiWS = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");

    // IMPORTANT: do not set session.conversation here (causes invalid_request_error).
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio"], // talk-only
          voice: "alloy",
          output_audio_format: "g711_ulaw" // Twilio μ-law
        }
      })
    );

    // Ask OpenAI to speak our greeting (we request only audio out).
    openaiWS.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          audio_format: "g711_ulaw",
          conversation: "none", // valid here (NOT in session.update)
          instructions: GREETING
        }
      })
    );
  });

  // Pipe audio deltas from OpenAI -> Twilio
  openaiWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Preferred (new) format
      if (
        msg.type === "response.output_audio.delta" &&
        msg.audio &&
        typeof msg.audio.delta === "string"
      ) {
        if (streamSid) {
          twilioWS.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.audio.delta }
            })
          );
        }
        return;
      }

      // Back-compat legacy format
      if (msg.type === "audio.delta" && typeof msg.delta === "string") {
        if (streamSid) {
          twilioWS.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta }
            })
          );
        }
        return;
      }

      // Log server-side hints if something goes wrong
      if (msg.type === "error" || msg.error) {
        console.error("[OpenAI ERROR]", msg);
      }
    } catch (e) {
      console.error("[OpenAI] parse error:", e);
    }
  });

  openaiWS.on("close", (code, reason) => {
    console.log(`[OpenAI] WS closed ${code} ${reason || ""}`.trim());
    if (callActive) {
      try {
        twilioWS.close();
      } catch (_) {}
    }
  });

  openaiWS.on("error", (err) => {
    console.error("[OpenAI] error", err);
  });

  // ---- Twilio events
  twilioWS.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { event } = data || {};

    switch (event) {
      case "connected":
        console.log("Twilio event: connected");
        break;

      case "start":
        streamSid = data?.start?.streamSid;
        console.log("Twilio event: start", {
          streamSid,
          format: data?.start?.mediaFormat
        });

        // Send ~400ms μ-law silence immediately so Twilio keeps the stream
        // alive while OpenAI prepares the first audio frames.
        if (streamSid) sendUlawSilence(twilioWS, streamSid, 400);
        break;

      case "media":
        // TALK-ONLY: ignore inbound caller audio (prevents echo).
        break;

      case "stop":
        console.log("Twilio event: stop (hangup)");
        callActive = false;
        try {
          openaiWS.close();
        } catch (_) {}
        try {
          twilioWS.close();
        } catch (_) {}
        break;

      default:
        // console.log("Twilio event:", event); // optional debug
        break;
    }
  });

  twilioWS.on("close", () => {
    console.log("Twilio socket closed");
    callActive = false;
    try {
      openaiWS.close();
    } catch (_) {}
  });

  twilioWS.on("error", (err) => {
    console.error("Twilio WS error:", err);
    callActive = false;
    try {
      openaiWS.close();
    } catch (_) {}
  });
});

// ---- start server
server.listen(PORT, () => {
  console.log(`==> Running on port ${PORT}`);
  console.log(
    `==> Available at your primary URL (e.g. https://your-app.onrender.com)`
  );
});
