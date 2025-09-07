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
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Barber AI Realtime bridge is alive.\n");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWS) => {
  console.log("[Twilio] connected");

  // ---- state/guards --------------------------------------------------------
  let twilioReady = false;               // set true after we get Twilio 'start'
  const pendingAudio = [];               // buffer OpenAI audio until Twilio ready

  const safeSendTwilio = (msgObj) => {
    if (!twilioReady) {
      if (msgObj && msgObj.event === "media") {
        pendingAudio.push(msgObj);       // buffer only audio frames before ready
      }
      return;
    }
    if (twilioWS.readyState === WebSocket.OPEN) {
      try {
        twilioWS.send(JSON.stringify(msgObj));
      } catch (err) {
        console.error("[Twilio send error]", err);
      }
    }
  };

  const flushPendingAudio = () => {
    while (pendingAudio.length && twilioWS.readyState === WebSocket.OPEN) {
      const frame = pendingAudio.shift();
      try {
        twilioWS.send(JSON.stringify(frame));
      } catch (err) {
        console.error("[Twilio flush error]", err);
        break;
      }
    }
  };

  // ---- OpenAI client socket ------------------------------------------------
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        "x-openai-audio-output-format": "g711_ulaw",
      },
    }
  );

  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");
  
    // Prime the session
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],       // we want both text + audio
          voice: "alloy",                      // voice to use
          output_audio_format: { type: "g711_ulaw" }, // correct object form for Twilio
          // ❌ no input_audio_format yet (we’re not streaming caller audio now)
        },
      })
    );
  });

  // Forward OpenAI audio -> Twilio (buffer until Twilio ready)
  openaiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.audio.delta") {
        safeSendTwilio({
          event: "media",
          media: { payload: msg.delta },
        });
      } else if (msg.type === "error") {
        console.error("[OpenAI ERROR]", msg);
      }
    } catch (e) {
      console.error("OpenAI message parse error", e);
    }
  });

  // ---- Twilio inbound ------------------------------------------------------
  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
  
      if (msg.event === "start") {
        console.log("[Twilio] stream start:", msg.start.streamSid);
        twilioReady = true;
        flushPendingAudio?.();
  
        // Ask OpenAI to speak immediately
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: "Hello from Barber AI. If you can hear this, the OpenAI link works.",
          },
        }));
        return;
      }
  
      // MEDIA HANDLING DISABLED (uncomment later for two-way)
      /*
      if (msg.event === "media") {
        if (openaiWS && openaiWS.readyState === openaiWS.OPEN) {
          openaiWS.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload, // base64 G.711 μ-law
          }));
        }
        return;
      }
      */
  
      if (msg.event === "stop") {
        console.log("[Twilio] stop");
        safeClose?.(openaiWS);
        safeClose?.(twilioWS);
        return;
      }
  
    } catch (e) {
      console.error("Twilio message parse error", e);
    }
  });

  // Commit input audio regularly so OpenAI consumes it
  const commitTimer = setInterval(() => {
    if (openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  }, 250);

  const cleanup = () => clearInterval(commitTimer);

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

function safeClose(ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch {}
}
