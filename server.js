import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}

const app = express();
app.get("/", (req, res) => res.send("OK"));
const server = http.createServer(app);

/**
 * We accept Twilio's media websocket at /media.
 * For each Twilio connection:
 *  - Open a separate WS to OpenAI Realtime
 *  - Configure session for voice + g711_ulaw output
 *  - Ask OpenAI to say a short greeting
 *  - Pipe OpenAI audio deltas back to Twilio as <media> payloads
 */
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (url === "/media") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (twilioWS) => {
  const tag = randTag();

  console.info(`[${tag}] Twilio connected`);

  // Hold onto the streamSid once Twilio sends the "start" message
  let streamSid = null;

  // --- OpenAI Realtime WS ---
  const openaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_REALTIME_MODEL
  )}`;
  const openaiWS = new (await import("ws")).default(openaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWS.on("open", () => {
    console.info(`[${tag}] [OpenAI] WS open`);

    // Configure the realtime session: voice + output format for Twilio
    openaiSendJSON(openaiWS, {
      type: "session.update",
      session: {
        // Use any supported voice name; "alloy" is common
        voice: "alloy",
        // We want text + audio responses
        modalities: ["text", "audio"],
        // Make the audio format what Twilio expects
        output_audio_format: "g711_ulaw"
      }
    });

    // Ask the model to immediately speak a sentence
    openaiSendJSON(openaiWS, {
      type: "response.create",
      response: {
        instructions:
          "Hello! You are connected to Barber AI. This is a quick audio test. Nice to meet you!",
        // With session.modalities already set, we don't need response.modalities here
      }
    });
  });

  // Forward OpenAI audio to Twilio as media frames
  openaiWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // You’ll see a lot of events. We care about audio chunks:
      if (data.type === "response.audio.delta" && data.audio) {
        if (streamSid && twilioWS.readyState === twilioWS.OPEN) {
          twilioWS.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: data.audio } // Base64 μ-law 8k audio
            })
          );
        }
      }
    } catch (err) {
      console.warn(`[${tag}] [OpenAI] parse error:`, err);
    }
  });

  openaiWS.on("close", () => {
    console.info(`[${tag}] [OpenAI] closed`);
    if (twilioWS.readyState === twilioWS.OPEN) twilioWS.close();
  });

  openaiWS.on("error", (err) => {
    console.error(`[${tag}] [OpenAI] error:`, err);
    if (twilioWS.readyState === twilioWS.OPEN) twilioWS.close();
  });

  // --- Twilio side ---
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start":
          streamSid = data.start?.streamSid;
          console.info(`[${tag}] Twilio stream started: ${streamSid}`);
          break;

        case "connected":
          console.info(`[${tag}] Twilio connected`);
          break;

        case "media":
          // We don't need to forward caller audio for this minimal "say hello" demo.
          // (If/when you want full two-way, you can send frames into OpenAI.)
          break;

        case "stop":
          console.info(`[${tag}] Twilio stop`);
          if (openaiWS.readyState === openaiWS.OPEN) openaiWS.close();
          break;

        default:
          // console.log(`[${tag}] Twilio event:`, data.event);
          break;
      }
    } catch (err) {
      console.warn(`[${tag}] Twilio parse error:`, err);
    }
  });

  twilioWS.on("close", () => {
    console.info(`[${tag}] Twilio closed`);
    if (openaiWS.readyState === openaiWS.OPEN) openaiWS.close();
  });

  twilioWS.on("error", (err) => {
    console.error(`[${tag}] Twilio error:`, err);
    if (openaiWS.readyState === openaiWS.OPEN) openaiWS.close();
  });
});

server.listen(PORT, () => {
  console.log(`==> Minimal WS server ready at http://0.0.0.0:${PORT}`);
});

/* ------------------ helpers ------------------ */

function openaiSendJSON(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    // no-op
  }
}

function randTag() {
  return Math.random().toString(36).slice(2, 6);
}
