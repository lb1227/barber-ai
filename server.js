import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Optional: a simple health page
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Barber AI Realtime bridge is alive.\n");
});

// A single WebSocketServer that we attach upgrade requests to.
const wss = new WebSocketServer({ noServer: true });

// Upgrade handling: only accept /media as Twilio’s stream
server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Each Twilio call = one WS connection here
wss.on("connection", (twilioWS) => {
  console.log("[Twilio] connected");

  // Create a **client** WebSocket to OpenAI
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        // Tell OpenAI to send audio we can play straight to Twilio (G.711 μ-law)
        "x-openai-audio-output-format": "g711_ulaw"
      }
    }
  );

  // When OpenAI is ready, configure session and send a greeting
  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");
    // Configure the session with audio out (and optional voice)
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: "alloy",
          output_audio_format: "g711_ulaw"
        }
      })
    );

    // Minimal greeting. This does NOT depend on any mic audio.
    openaiWS.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Hello from Barber AI. If you can hear this, the OpenAI link works."
        }
      })
    );
  });

  // Forward OpenAI audio to Twilio
  openaiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.audio.delta") {
        // Twilio expects base64 audio in the "media.payload"
        twilioWS.send(
          JSON.stringify({
            event: "media",
            media: { payload: msg.delta }
          })
        );
      } else if (msg.type === "error") {
        console.error("[OpenAI ERROR]", msg);
      }
    } catch (e) {
      console.error("OpenAI message parse error", e);
    }
  });

  // Handle Twilio messages (optional audio upstream)
  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "start") {
        console.log("[Twilio] stream start:", msg.start.streamSid);
      } else if (msg.event === "media") {
        // If you want the model to hear you, append audio to input buffer
        // (Twilio media.payload is base64 G.711 μ-law)
        openaiWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload
          })
        );
      } else if (msg.event === "stop") {
        console.log("[Twilio] stop");
        safeClose(openaiWS);
        safeClose(twilioWS);
      }
    } catch (e) {
      console.error("Twilio message parse error", e);
    }
  });

  // Commit input audio periodically so OpenAI processes it (prevents 0.00ms errors)
  const commitTimer = setInterval(() => {
    if (openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  }, 250);

  const cleanup = () => {
    clearInterval(commitTimer);
  };

  twilioWS.on("close", () => {
    console.log("[Twilio] closed");
    cleanup();
    safeClose(openaiWS);
  });

  openaiWS.on("close", () => {
    console.log("[OpenAI] closed");
    cleanup();
    safeClose(twilioWS);
  });

  twilioWS.on("error", (e) => console.error("[Twilio WS error]", e));
  openaiWS.on("error", (e) => console.error("[OpenAI WS error]", e));
});

server.listen(PORT, () => {
  console.log(`Minimal WS server ready at http://0.0.0.0:${PORT}`);
});

// helper
function safeClose(ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch {}
}
