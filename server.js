// server.js - talk-only (OpenAI -> Twilio). Waits for session.updated, logs all events.
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

app.get("/", (_req, res) => res.type("text").send("OK"));

function sendTwilioMedia(ws, streamSid, base64ULaw) {
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: base64ULaw },
    })
  );
}

function connectOpenAI(onEvent, onOpen, onClose, onError) {
  const url =
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

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
      console.error("raw:", msg.toString());
    }
  });
  openai.on("close", onClose);
  openai.on("error", onError);
  return openai;
}

wss.on("connection", (twilio) => {
  let streamSid = null;
  let openai = null;
  let sessionReady = false;
  let greetingSent = false;

  console.log("==> Twilio connected");

  twilio.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }
    const { event } = data;

    if (event === "start") {
      streamSid = data.start.streamSid;
      console.log("==> Call started", {
        accountSid: data.start.accountSid,
        streamSid,
        format: data.start.mediaFormat,
      });

      // Connect to OpenAI realtime
      openai = connectOpenAI(
        // onEvent
        (evt) => {
          // Log everything for now so we see any problems
          console.log("[OpenAI evt]", evt.type || evt);

          // Session is ready -> now ask it to speak
          if (evt.type === "session.updated") {
            sessionReady = true;

            if (!greetingSent) {
              greetingSent = true;
              openai.send(
                JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: ["audio"],             // audio only
                    audio_format: "g711_ulaw",         // Twilio-compatible
                    conversation: "none",              // don't store memory
                    instructions:
                      "Hi! This is the Barber AI. I'm just saying hello right now. Have a great day!",
                  },
                })
              );
              console.log("[OpenAI] greeting requested");
            }
          }

          // Some builds send audio as response.audio.delta with {audio}
          if (evt.type === "response.audio.delta" && evt.audio) {
            sendTwilioMedia(twilio, streamSid, evt.audio);
          }

          // Some builds send response.output_audio.delta with {audio}
          if (evt.type === "response.output_audio.delta" && evt.audio) {
            sendTwilioMedia(twilio, streamSid, evt.audio);
          }

          // Some builds send chunks as buffer.append
          if (
            evt.type === "response.output_audio.buffer.append" &&
            evt.audio
          ) {
            sendTwilioMedia(twilio, streamSid, evt.audio);
          }

          if (evt.type === "response.completed") {
            console.log("[OpenAI] response completed");
          }

          if (evt.type === "error" || evt.error) {
            console.error("[OpenAI ERROR]", evt);
          }
        },
        // onOpen
        () => {
          console.log("[OpenAI] WS open");

          // Do NOT send response.create yet; first update session
          openai.send(
            JSON.stringify({
              type: "session.update",
              session: {
                // You can try different voices if you like
                voice: "alloy",
                modalities: ["audio"],       // only output audio
                output_audio_format: "g711_ulaw",
                conversation: "none",
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

    // Ignore inbound audio for now (talk-only)
    if (event === "media") return;

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

  twilio.on("error", (err) => console.error("[Twilio WS] error", err));
});

server.listen(PORT, () => {
  console.log("Listening on", PORT);
  console.log("Primary URL:", `https://barber-ai.onrender.com`);
});
