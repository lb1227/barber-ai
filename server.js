// server.js - one-way TTS: OpenAI -> Twilio (no listening yet)
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in env");
  process.exit(1);
}

const PORT = process.env.PORT || 10000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

app.get("/", (_req, res) => {
  res.type("text").send("OK");
});

// Small helper to send Twilio media message
function sendTwilioMedia(ws, streamSid, base64ULaw) {
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: base64ULaw },
    })
  );
}

// OpenAI realtime connection
function connectOpenAI(onEvent, onOpen, onClose, onError) {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

  const openai = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openai.on("open", onOpen);
  openai.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      onEvent(data);
    } catch (e) {
      console.error("[OpenAI] JSON parse error:", e);
    }
  });
  openai.on("close", onClose);
  openai.on("error", onError);
  return openai;
}

wss.on("connection", (twilio) => {
  let streamSid = null;
  let openai = null;
  let openaiReady = false;

  console.log("==> Twilio connected");

  twilio.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const { event } = data;

    if (event === "start") {
      streamSid = data.start.streamSid;
      const mediaFormat = data.start.mediaFormat;
      console.log("==> Call started", {
        accountSid: data.start.accountSid,
        streamSid,
        format: mediaFormat,
      });

      // 1) Connect to OpenAI (audio only)
      openai = connectOpenAI(
        // onEvent
        (evt) => {
          // We ONLY care about audio deltas and the completion
          if (evt.type === "response.audio.delta" && evt.audio) {
            // evt.audio is base64 g711_ulaw chunk
            sendTwilioMedia(twilio, streamSid, evt.audio);
          } else if (evt.type === "response.completed") {
            console.log("[OpenAI] response completed");
            // Keep the line open; or close after short delay if you prefer:
            // setTimeout(() => twilio.close(), 800);
          }
        },
        // onOpen
        () => {
          console.log("[OpenAI] WS open");

          // 2) Configure the session: AUDIO ONLY, g711_ulaw out, no conversation
          // NOTE: do NOT set session.response here (it was causing “unknown parameter”).
          openaiReady = true;
          openai.send(
            JSON.stringify({
              type: "session.update",
              session: {
                // any stock voice here; 'verse' / 'alloy' / 'sage' etc.
                voice: "verse",
                // we only want audio out for now
                modalities: ["audio"],
                // sample rate & format for Twilio to match
                output_audio_format: "g711_ulaw",
                // do not keep conversation memory
                conversation: "none",
              },
            })
          );

          // 3) Ask OpenAI to speak a greeting (one-shot)
          openai.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio"],
                audio_format: "g711_ulaw",
                conversation: "none",
                instructions:
                  "Hi! This is the Barber AI. I can hear you soon, but right now I'm just saying hello. Have a great day!",
              },
            })
          );
        },
        // onClose
        (code, reason) => {
          console.log("[OpenAI] closed", code, reason?.toString() || "");
        },
        // onError
        (err) => {
          console.error("[OpenAI] error", err);
        }
      );
    }

    // Twilio “media” (inbound µ-law frames). We IGNORE these so there is no echo
    // and no audio buffer commits. We are *talk only* for now.
    if (event === "media") {
      // no-op; we are not streaming input audio to OpenAI in this phase
      return;
    }

    if (event === "stop") {
      console.log("==> Twilio stop (hangup)");
      try {
        openai?.close();
      } catch {}
      twilio.close();
    }
  });

  twilio.on("close", () => {
    console.log("==> Twilio socket closed");
    try {
      openai?.close();
    } catch {}
  });

  twilio.on("error", (err) => {
    console.error("[Twilio WS] error", err);
  });
});

server.listen(PORT, () => {
  console.log("Listening on", PORT);
  console.log("Primary URL:", `https://barber-ai.onrender.com`);
});
