// server.js  — Twilio <-> OpenAI Realtime bridge (ESM)
// Requires env: OPENAI_API_KEY, OPENAI_REALTIME_MODEL (optional)
// Works with TwiML Bin that <Connect><Stream url="wss://YOUR_HOST/twilio"/></Connect>

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);

// Simple health check
app.get("/health", (_, res) => res.status(200).send("ok"));

// ---- WebSocket bridge for Twilio media stream ----
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", async (twilioWS) => {
  console.log("Twilio WS connected.");
  let streamSid = null;

  // Connect to OpenAI Realtime
  const model =
    process.env.OPENAI_REALTIME_MODEL ||
    "gpt-4o-realtime-preview-2024-12-17";

  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let oaiReady = false;
  let responsePending = false;

  const safeSendOAI = (obj) => {
    if (oaiReady && oaiWS.readyState === WebSocket.OPEN) {
      oaiWS.send(JSON.stringify(obj));
    }
  };

  oaiWS.on("open", () => {
    oaiReady = true;
    console.log("OpenAI WS open");

    // Configure session for ulaw in/out + audio+text mods + valid voice
    safeSendOAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "verse",
      },
    });

    // Initial hello
    responsePending = true;
    safeSendOAI({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Say: Hello! How can I help you?",
      },
    });
  });

  oaiWS.on("error", (err) => console.error("OpenAI WS error:", err));
  oaiWS.on("close", () => console.log("OpenAI WS closed"));

  // Buffer Twilio frames so each commit >= ~200ms (Twilio frames ~20ms)
  const FRAMES_PER_COMMIT = 10;
  let frameBucket = [];

  // Handle messages from Twilio
  twilioWS.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid;
        console.log("Twilio start, stream:", streamSid);
        break;

      case "media":
        // accumulate base64 μ-law frames
        frameBucket.push(msg.media?.payload);
        if (frameBucket.length >= FRAMES_PER_COMMIT) {
          const ulaw = Buffer.concat(
            frameBucket.map((b64) => Buffer.from(b64, "base64"))
          );
          frameBucket = [];

          // Append >=100ms audio, then commit, then (if none pending) request a reply
          safeSendOAI({
            type: "input_audio_buffer.append",
            audio: ulaw.toString("base64"),
          });
          safeSendOAI({ type: "input_audio_buffer.commit" });

          if (!responsePending) {
            responsePending = true;
            safeSendOAI({
              type: "response.create",
              response: { modalities: ["audio"] },
            });
          }
        }
        break;

      case "stop":
        console.log("Twilio stop");
        try {
          oaiWS.close();
        } catch {}
        try {
          twilioWS.close();
        } catch {}
        break;

      default:
        break;
    }
  });

  // Relay OpenAI audio -> Twilio
  oaiWS.on("message", (data) => {
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (ev.type === "response.output_audio.delta" && ev.delta && streamSid) {
      // Already ulaw because of output_audio_format
      twilioWS.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: ev.delta },
        })
      );
    } else if (
      ev.type === "response.completed" ||
      ev.type === "response.output_audio.done" ||
      ev.type === "response.final"
    ) {
      responsePending = false;
      if (streamSid) {
        twilioWS.send(
          JSON.stringify({
            event: "mark",
            streamSid,
            mark: { name: "oai_response_done" },
          })
        );
      }
    } else if (ev.type === "error") {
      console.error("OpenAI Realtime ERROR:", ev);
    }
  });

  twilioWS.on("close", () => {
    console.log("Twilio WS closed");
    try {
      oaiWS.close();
    } catch {}
  });

  twilioWS.on("error", (err) => console.error("Twilio WS error:", err));

  // Keep-alive
  const keep = setInterval(() => {
    try {
      twilioWS.ping();
    } catch {}
    try {
      oaiWS.ping?.();
    } catch {}
  }, 15000);
  twilioWS.once("close", () => clearInterval(keep));
  oaiWS.once?.("close", () => clearInterval(keep));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
