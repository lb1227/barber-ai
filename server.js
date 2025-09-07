// Minimal OpenAI <-> Twilio talk-back bridge.
// Goal: as soon as a Twilio call connects, OpenAI says a greeting that is
// streamed back to the caller. No STT/ASR needed to prove talking works.

import http from "http";
import { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

// ---------- HTTP server (for Render) ----------
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Barber AI - minimal OpenAI talk-back bridge");
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ---------- WebSocket “/media” for Twilio ----------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (twilioWS) => {
  console.log("=> Twilio WS connected");

  let streamSid = null;       // Twilio stream SID (from "start" event)
  let openaiWS = null;        // OpenAI realtime WS
  let haveAnyInboundAudio = false; // avoid committing empty buffers

  // ---- Connect to OpenAI Realtime WS ----
  openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openaiWS.on("open", () => {
    console.log("=> [OpenAI] WS open");

    // Configure the session: produce G.711 u-law at 8k for Twilio
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "alloy",
        modalities: ["text", "audio"],
        output_audio_format: { type: "g711_ulaw" },   // 8k u-law -> matches Twilio
        input_audio_format: "g711_ulaw"               // we can forward Twilio audio directly if needed
      }
    }));

    // Ask OpenAI to speak a greeting immediately (no input required)
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hello! You are connected to Barber AI. This is a quick voice test.",
        conversation: "none"
      }
    }));
  });

  // Forward OpenAI audio back to Twilio
  openaiWS.on("message", (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // The realtime API will stream audio deltas as base64 g711-ulaw
    if (msg.type === "response.output_audio.delta" && msg.audio && streamSid) {
      // send to Twilio as a media frame (base64 ULaw at 8k)
      const payload = msg.audio; // already base64
      twilioWS.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload }
      }));
    }

    if (msg.type === "response.completed") {
      // Optional: you can ask OpenAI to keep talking or end, etc.
      console.log("=> [OpenAI] response completed");
    }

    if (msg.type === "error") {
      console.error("=> [OpenAI ERROR]", msg);
    }
  });

  openaiWS.on("close", () => {
    console.log("=> [OpenAI] WS closed");
    if (twilioWS.readyState === twilioWS.OPEN) {
      twilioWS.close();
    }
  });

  openaiWS.on("error", (err) => {
    console.error("=> [OpenAI] WS error:", err);
  });

  // ---- Receive Twilio media events ----
  twilioWS.on("message", (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("=> Twilio stream started:", streamSid);
    }

    if (msg.event === "media") {
      // If you want the assistant to also listen to the caller later,
      // forward Twilio audio to OpenAI (we set input_audio_format to 'g711_ulaw')
      // Not required for the greeting to play; just makes the path complete.
      haveAnyInboundAudio = true;
      if (openaiWS && openaiWS.readyState === openaiWS.OPEN) {
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      }
    }

    if (msg.event === "stop") {
      console.log("=> Twilio stop");
      if (openaiWS && openaiWS.readyState === openaiWS.OPEN) {
        openaiWS.close();
      }
    }
  });

  twilioWS.on("close", () => {
    console.log("=> [Twilio] closed");
    if (openaiWS && openaiWS.readyState === openaiWS.OPEN) {
      openaiWS.close();
    }
  });

  twilioWS.on("error", (err) => {
    console.error("=> [Twilio] WS error:", err);
  });
});

// Render binds your app to PORT
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("==> ///////////////////////////////////////////////");
  console.log("==> Available at your primary URL https://barber-ai.onrender.com");
  console.log("==> ///////////////////////////////////////////////");
  console.log(`==> Minimal WS server ready at http://0.0.0.0:${PORT}`);
});
