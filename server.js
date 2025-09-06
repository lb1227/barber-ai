// server.js  —  Minimal Twilio <-> OpenAI Realtime "Hello" bridge
// CommonJS style to avoid ESM/require mismatches.
// Env needed: OPENAI_API_KEY, OPENAI_REALTIME_MODEL (optional)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("ERROR: Missing OPENAI_API_KEY");
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic health check
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// (Optional) Twilio stream status callback endpoint (just logs if you wire it later)
app.post("/twilio-status", (req, res) => {
  console.log("Twilio status callback body:", req.body);
  res.sendStatus(200);
});

const server = http.createServer(app);

// We'll manually upgrade only for /twilio
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    console.log("HTTP UPGRADE attempt:", {
      url: req.url,
      host: req.headers.host,
      ua: req.headers["user-agent"],
      upgrade: req.headers.upgrade,
      proto: req.headers["sec-websocket-protocol"],
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWS, req) => {
  console.log("✅ WS CONNECTED on /twilio from", req.socket.remoteAddress);

  let streamSid = null;
  let openaiWS = null;

  // --- open OpenAI realtime socket and say hello ---
  const connectOpenAI = () => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_MODEL
    )}`;

    openaiWS = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWS.on("open", () => {
      console.log("✅ OpenAI WS open");

      // Configure formats to μ-law both directions and audio-only
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["audio"], // just audio for now
          voice: "verse",        // valid voice
          input_audio_format: "g711_ulaw",
          audio_format: "g711_ulaw", // output format
        },
      };
      openaiWS.send(JSON.stringify(sessionUpdate));

      // Ask OpenAI to speak a short hello so we can verify outbound audio
      const hello = {
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Say: Hello! I'm connected. This is a test message from OpenAI Realtime.",
        },
      };
      openaiWS.send(JSON.stringify(hello));
    });

    // Forward OpenAI audio frames to Twilio
    openaiWS.on("message", (data) => {
      try {
        const evt = JSON.parse(data.toString());

        if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
          // evt.delta is base64 audio in g711_ulaw (because we set audio_format)
          const out = {
            event: "media",
            streamSid,
            media: { payload: evt.delta },
          };
          if (twilioWS.readyState === WebSocket.OPEN) {
            twilioWS.send(JSON.stringify(out));
          }
        }

        if (evt.type === "response.completed") {
          console.log("INFO OpenAI response done.");
        }

        if (evt.type === "error") {
          console.error("OpenAI ERROR:", evt);
        }
      } catch (e) {
        console.error("ERR parsing OpenAI message:", e);
      }
    });

    openaiWS.on("close", (code, reason) => {
      console.log("OpenAI WS closed", code, reason?.toString());
    });

    openaiWS.on("error", (err) => {
      console.error("OpenAI WS error", err);
    });
  };

  // --- handle messages from Twilio ---
  twilioWS.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.error("ERR parsing Twilio message", e);
      return;
    }

    const { event } = data;

    if (event === "connected") {
      console.log("Twilio event: connected");
      // nothing to do yet
    }

    if (event === "start") {
      streamSid = data.start?.streamSid;
      const tracks = data.start?.tracks;
      const fmt = data.start?.mediaFormat;

      console.log("🔷 media START {");
      console.log("  streamSid:", streamSid);
      console.log("  tracks:", tracks);
      console.log(
        "  fmt:",
        fmt || { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
      );
      console.log("}");

      // Open the OpenAI socket now
      connectOpenAI();
    }

    // We ignore inbound audio for this test round-trip on purpose
    // (We'll wire microphone -> OpenAI after we confirm you hear the hello.)
    if (event === "media") {
      // data.media.payload is base64 g711_ulaw (20ms chunks).
      // For now, do nothing.
    }

    if (event === "mark") {
      // ignore
    }

    if (event === "stop") {
      console.log("🔶 media STOP", streamSid);
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.close();
      }
      twilioWS.close();
    }
  });

  twilioWS.on("close", (code, reason) => {
    console.log("WS CLOSED", code, reason?.toString());
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.close();
    }
  });

  twilioWS.on("error", (err) => {
    console.error("Twilio WS error", err);
  });
});

server.listen(PORT, () => {
  console.log(`==> Server listening on ${PORT}`);
  console.log("==> Your service is live 🎉");
  console.log("==> //////////////////////////////////////////////");
  console.log(
    "==> Available at your primary URL https://barber-ai.onrender.com"
  );
  console.log("==> //////////////////////////////////////////////");
});
