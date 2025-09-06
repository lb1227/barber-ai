// server.js
// Minimal Twilio <-> OpenAI Realtime bridge (talk-only).
// Twilio hears a greeting; we DO NOT feed caller audio back to OpenAI (no echo).

// -------------------------
// Config
// -------------------------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // must be set
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const GREETING =
  "Hi! This is the Barber AI. I'm just saying hello right now. Have a great day!";

// -------------------------
// Imports
// -------------------------
require("dotenv").config?.();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

// -------------------------
// App & HTTP server
// -------------------------
const app = express();
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
const server = http.createServer(app);

// -------------------------
// WebSocket endpoint for Twilio
// -------------------------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // Only accept our /media endpoint
  if (!req.url || !req.url.startsWith("/media")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (twilioWS, req) => {
  console.log("==> Twilio connected");

  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Closing call.");
    twilioWS.close();
    return;
  }

  // Keep Twilio state
  let streamSid = null;
  let callActive = true;

  // -------------------------
  // OpenAI Realtime (as client)
  // -------------------------
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_MODEL
  )}`;

  const openaiWS = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // When OpenAI WS is open: set audio output to μ-law & send greeting
  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");

    // 1) Session settings — DO NOT include 'conversation' here
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio"], // we're only outputting audio
          voice: "alloy",
          output_audio_format: "g711_ulaw", // matches Twilio μ-law
        },
      })
    );

    // 2) Ask OpenAI to speak our greeting (talk-only)
    openaiWS.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          audio_format: "g711_ulaw",
          conversation: "none", // ✅ valid here (NOT in session.update)
          instructions: GREETING,
        },
      })
    );
  });

  // Forward OpenAI audio deltas to Twilio
  openaiWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Newer schema (preferred)
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
              media: { payload: msg.audio.delta },
            })
          );
        }
        return;
      }

      // Compatibility with older "audio.delta" style payloads
      if (
        msg.type === "audio.delta" &&
        typeof msg.delta === "string"
      ) {
        if (streamSid) {
          twilioWS.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta },
            })
          );
        }
        return;
      }

      // Debug other events (optional)
      if (msg.type && msg.type !== "response.output_audio.delta" && msg.type !== "audio.delta") {
        // Uncomment to see all messages:
        // console.log("[OpenAI]", msg.type);
      }
    } catch (e) {
      console.error("[OpenAI] parse error:", e);
    }
  });

  openaiWS.on("close", (code, reason) => {
    console.log(`[OpenAI] WS closed ${code} ${reason}`);
    // Close Twilio leg if still open
    if (callActive) {
      try {
        twilioWS.close();
      } catch (_) {}
    }
  });

  openaiWS.on("error", (err) => {
    console.error("[OpenAI] error", err);
  });

  // -------------------------
  // Handle messages from Twilio
  // -------------------------
  twilioWS.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      // Twilio sends only JSON — ignore junk
      return;
    }

    const { event } = data || {};
    switch (event) {
      case "connected":
        console.log("Twilio event: connected");
        break;

      case "start":
        streamSid = data?.start?.streamSid;
        console.log("Twilio event: start", { streamSid, format: data?.start?.mediaFormat });
        break;

      case "media":
        // We are TALK-ONLY — do NOT forward caller audio to OpenAI.
        // (This avoids echo and keeps things simple.)
        // If/when you want listening, buffer & send audio to OpenAI with
        // input_audio_buffer.append + input_audio_buffer.commit.
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

// -------------------------
// Start server
// -------------------------
server.listen(PORT, () => {
  console.log(`==> Running on port ${PORT}`);
  console.log(`==> Available at your primary URL`);
});
