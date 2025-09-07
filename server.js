import express from "express";
import http from "http";
import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const app = express();
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.send("healthy"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

/**
 * Helpers
 */
function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
}

function sendTwilioMedia(wsTwilio, streamSid, base64Payload) {
  const msg = {
    event: "media",
    streamSid,
    media: {
      payload: base64Payload,
    },
  };
  wsTwilio.send(JSON.stringify(msg));
}

/**
 * Handle upgrades — only /media is a WS endpoint
 */
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (wsTwilio) => {
  const id = Math.random().toString(36).slice(2, 8);
  log(id, "Twilio WS connected");

  let streamSid = null;
  let ai = null;
  let aiOpen = false;
  let finished = false;

  // Keep Twilio media stream alive
  const keepAlive = setInterval(() => {
    if (wsTwilio.readyState === WebSocket.OPEN) {
      wsTwilio.send(JSON.stringify({ event: "keepalive" }));
    }
  }, 15000);

  wsTwilio.on("message", async (msgBuf) => {
    // Twilio sends JSON messages
    let data;
    try {
      data = JSON.parse(msgBuf.toString("utf8"));
    } catch {
      return;
    }

    // Capture streamSid and start OpenAI when we see the "start" event
    if (data.event === "start") {
      streamSid = data.start?.streamSid;
      log(id, "Twilio start", streamSid);

      // Create OpenAI Realtime WS (audio -> Twilio only)
      ai = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
          },
        }
      );

      ai.on("open", () => {
        aiOpen = true;
        log(id, "OpenAI WS open");

        // Configure the session to output μ-law 8k to match Twilio:
        ai.send(
          JSON.stringify({
            type: "session.update",
            session: {
              // IMPORTANT: we only need the AI to speak; do not read mic audio
              modalities: ["audio", "text"],
              voice: "alloy",
              output_audio_format: "g711_ulaw", // Twilio's expected codec
            },
          })
        );

        // Ask OpenAI to speak a single line
        ai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                "Hello, you are connected to Barber AI. This is a minimal connectivity test.",
            },
          })
        );
      });

      ai.on("message", (raw) => {
        // OpenAI Realtime sends JSON events; some will contain μ-law chunks
        let evt;
        try {
          evt = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Stream audio out to Twilio as we receive it
        if (
          evt.type === "response.output_audio.delta" &&
          evt.audio &&
          streamSid &&
          wsTwilio.readyState === WebSocket.OPEN
        ) {
          // evt.audio is base64-encoded G.711 μ-law @8kHz; send directly to Twilio
          sendTwilioMedia(wsTwilio, streamSid, evt.audio);
        }

        // When the response is finished, we can stop
        if (evt.type === "response.completed" || evt.type === "response.done") {
          finished = true;
          log(id, "OpenAI response completed");
          try {
            ai.close();
          } catch {}
          // allow caller to sit briefly, then hang up (Twilio will close after inactivity)
          // or you can proactively send a <mark> or stop message if needed
        }

        // Log server warnings/errors for visibility
        if (evt.type === "error") {
          log(id, "OpenAI ERROR", evt);
        }
      });

      ai.on("close", () => {
        log(id, "OpenAI WS closed");
      });

      ai.on("error", (err) => {
        log(id, "OpenAI WS error", err?.message || err);
      });
    }

    // We IGNORE inbound media from Twilio (so no input buffer commits).
    // This is intentional for the “just speak” connectivity test.
  });

  wsTwilio.on("close", () => {
    clearInterval(keepAlive);
    log(id, "Twilio WS closed");
    try {
      if (ai && ai.readyState === WebSocket.OPEN) ai.close();
    } catch {}
  });

  wsTwilio.on("error", (e) => {
    log(id, "Twilio WS error", e?.message || e);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`==> Minimal WS server ready at http://0.0.0.0:${PORT}`);
});
