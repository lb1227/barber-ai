// server.js — Twilio Media Streams <-> OpenAI Realtime (g711 μ-law both ways)
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // <-- set this in Render env

const OPENAI_WS_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

const app = express();
const server = http.createServer(app);

// WS endpoint for Twilio Media Streams
const twilioWSS = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    twilioWSS.handleUpgrade(req, socket, head, (ws) => {
      twilioWSS.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

twilioWSS.on("connection", (twilioWs) => {
  console.log("✅ Twilio connected");

  // --- One OpenAI Realtime WS per call ---
  const openaiWs = new WebSocket(OPENAI_WS_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
      // no special subprotocol needed by ws; headers are sufficient
    },
  });

  let streamSid = null;
  let frameCountSinceCommit = 0;
  let greeted = false;
  let openaiReady = false;

  // ---- Twilio -> Server ----
  twilioWs.on("message", (msg) => {
    const s = msg.toString();
    let evt;
    try {
      evt = JSON.parse(s);
    } catch (e) {
      console.error("❌ Twilio parse error", e);
      return;
    }

    if (evt.event) {
      // Compact helpful logging
      if (evt.event === "start") {
        streamSid = evt.start?.streamSid;
        console.log("📞 Call started", {
          streamSid,
          format: evt.start?.mediaFormat,
          callSid: evt.start?.callSid,
        });
      }

      if (evt.event === "media") {
        const payload = evt.media?.payload;
        if (!payload || !openaiReady) return;

        // Append raw μ-law base64 frame to the model input audio buffer
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload, // base64 μ-law frame from Twilio
          })
        );

        frameCountSinceCommit++;

        // Commit every ~100ms (Twilio sends 20ms frames)
        if (frameCountSinceCommit >= 5) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

          // Ask model to reply (session "instructions" will guide behavior)
          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio"], // ask for audio reply
                conversation: "default",
              },
            })
          );

          frameCountSinceCommit = 0;
        }
      }

      if (evt.event === "stop") {
        console.log("🛑 Twilio stop");
        try { openaiWs.close(); } catch {}
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("❎ Twilio WS closed");
    try { openaiWs.close(); } catch {}
  });
  twilioWs.on("error", (e) => console.error("⚠️ Twilio WS error", e));

  // ---- OpenAI -> Server ----
  openaiWs.on("open", () => {
    console.log("✅ OpenAI WS open");

    // Configure the session for μ-law in/out and server VAD (turn detection)
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // short, natural voice; use any available voice name your account supports
        voice: "verse",
        // Enable server VAD for more natural turn-taking (optional)
        turn_detection: { type: "server_vad", silence_duration_ms: 700 },
        instructions:
          "You are a friendly barber shop receptionist. Keep responses short and helpful.",
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    // Optional: send a short greeting right away, so caller hears something even
    // before they speak
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          conversation: "default",
          instructions: "Greet the caller briefly and ask how you can help.",
        },
      })
    );

    openaiReady = true;
  });

  openaiWs.on("message", (data) => {
    // All Realtime events are JSON text frames
    let evt;
    try {
      evt = JSON.parse(data.toString());
    } catch (e) {
      console.error("❌ OpenAI parse error", e);
      return;
    }

    const type = evt.type;

    // Audio chunks stream as base64 μ-law for the configured output format
    if (type === "response.output_audio.delta") {
      // Send audio chunk back to Twilio
      if (streamSid && evt.delta) {
        const out = {
          event: "media",
          streamSid,
          media: { payload: evt.delta }, // base64 μ-law chunk
        };
        try {
          twilioWs.send(JSON.stringify(out));
        } catch (e) {
          console.error("❌ send to Twilio failed", e);
        }
      }
      return;
    }

    // Helpful logs for other states/errors
    if (type === "response.completed") {
      // Finished speaking this turn
      // console.log("✅ response.completed");
      return;
    }
    if (type === "error") {
      console.error("❌ OpenAI error", evt);
      return;
    }
    // Uncomment to inspect other events:
    // console.log("🔎 OA evt:", type);
  });

  openaiWs.on("close", () => console.log("❎ OpenAI WS closed"));
  openaiWs.on("error", (e) => console.error("⚠️ OpenAI WS error", e));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("🚀 Server running on", PORT));
