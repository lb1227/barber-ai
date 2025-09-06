// server.js (CommonJS) – Twilio <-> OpenAI Realtime bridge (μ-law pass-through, 8kHz, mono)
const express = require("express");
const http = require("http");
const bodyParser = require("body-parser");
const cors = require("cors");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Sanity check
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment.");
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Simple health
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Optional Twilio status callback logger (kept if you want to wire it)
app.post("/twilio-status", (req, res) => {
  console.info("Twilio status callback body:", JSON.stringify(req.body));
  res.sendStatus(200);
});

// Create an HTTP server and a WS server we’ll use for Twilio STREAM
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Upgrade only for /twilio
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ====== Twilio <-> OpenAI Bridge ======
wss.on("connection", (twilioWS, req) => {
  console.info("WS CONNECTED on /twilio from", req.socket.remoteAddress);

  // State
  let streamSid = null;
  let openaiWS = null;
  let openaiReady = false;
  let twilioReady = true; // if we got here, Twilio WS is up

  // Buffer for ≥100ms of μ-law audio before commit
  const MIN_COMMIT_BYTES = 800; // 8kHz * 100ms * 1 byte/sample (μ-law)
  let ulawBufferParts = [];
  let ulawBufferedBytes = 0;

  // Throttle commits a bit to avoid commit-with-0 bytes due to race
  let commitTimer = null;
  const COMMIT_INTERVAL_MS = 120; // little more than 100ms window

  const safeSendTwilio = (obj) => {
    try {
      if (twilioWS && twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify(obj));
      }
    } catch (e) {
      console.error("Twilio send error:", e);
    }
  };

  // Create & connect OpenAI WS
  const oaURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;
  openaiWS = new WebSocket(oaURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  const flushAndCommit = () => {
    if (!openaiReady) return;
    if (ulawBufferedBytes < MIN_COMMIT_BYTES) return;
    try {
      // Append the chunk we've aggregated
      const combined = Buffer.concat(ulawBufferParts);
      const base64Audio = combined.toString("base64");
      openaiWS.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        })
      );
      // Then commit
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } catch (e) {
      console.error("Commit error:", e);
    } finally {
      // reset buffer
      ulawBufferParts = [];
      ulawBufferedBytes = 0;
    }
  };

  const scheduleCommit = () => {
    if (commitTimer) return;
    commitTimer = setTimeout(() => {
      commitTimer = null;
      flushAndCommit();
    }, COMMIT_INTERVAL_MS);
  };

  // ===== OpenAI WS events =====
  openaiWS.on("open", () => {
    console.info("OpenAI WS open");
    // Configure session for μ-law pass-through
    // IMPORTANT: session.input_audio_format must be EXACT STRING, not object.
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
        },
      })
    );

    // Light prompt so we can hear something immediately
    openaiWS.send(
      JSON.stringify({
        type: "response.create",
        response: {
          // Keep it extremely simple until audio roundtrip is verified
          instructions: "Say 'Hello!'.",
          modalities: ["audio"],
          conversation: "auto",
        },
      })
    );

    openaiReady = true;
  });

  openaiWS.on("message", (data) => {
    // The Realtime server sends multiple event types.
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Forward audio deltas back to Twilio
    // For g711_ulaw, OpenAI returns base64 μ-law in "output_audio_buffer.delta"
    if (msg.type === "output_audio_buffer.delta" && msg.delta) {
      // Send 'outbound' audio toward the caller
      safeSendTwilio({
        event: "media",
        streamSid: streamSid || undefined,
        media: { payload: msg.delta }, // base64 μ-law
        track: "outbound",
      });
      return;
    }

    // When OpenAI marks the output audio buffer final, we could send a mark
    // or just ignore. Not necessary for basic hello test.
    if (msg.type === "error") {
      console.error("OpenAI ERROR:", msg);
    }
  });

  openaiWS.on("close", (code, reason) => {
    console.info("OpenAI WS closed", code, reason?.toString());
    openaiReady = false;
    try {
      twilioWS.close();
    } catch {}
  });

  openaiWS.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  // ===== Twilio WS events =====
  twilioWS.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { event } = payload;

    switch (event) {
      case "connected":
        console.info("Twilio event: connected");
        break;

      case "start":
        streamSid = payload.start?.streamSid;
        console.info("media START", payload.start);
        break;

      case "media": {
        // Twilio inbound audio (μ-law base64). We append & buffer; commit later.
        // NOTE: do not send to OpenAI until openaiReady is true.
        if (!openaiReady) return;
        const b64 = payload.media?.payload;
        if (!b64) return;

        // Accumulate into buffer
        const chunk = Buffer.from(b64, "base64");
        ulawBufferParts.push(chunk);
        ulawBufferedBytes += chunk.length;

        // Schedule a commit once we have enough bytes
        if (ulawBufferedBytes >= MIN_COMMIT_BYTES) {
          flushAndCommit();
        } else {
          scheduleCommit();
        }
        break;
      }

      case "mark":
        // ignore
        break;

      case "stop":
        console.info("media STOP", payload.stop);
        // Close politely
        try {
          if (openaiReady) openaiWS.send(JSON.stringify({ type: "response.cancel" }));
        } catch {}
        break;

      default:
        // Other Twilio events no-op
        break;
    }
  });

  twilioWS.on("close", () => {
    console.info("Twilio WS closed");
    if (commitTimer) clearTimeout(commitTimer);
    try {
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) openaiWS.close();
    } catch {}
  });

  twilioWS.on("error", (err) => {
    console.error("Twilio WS error:", err);
    try {
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) openaiWS.close();
    } catch {}
  });
});

// Boot
server.listen(PORT, () => {
  console.log("==> Your service is live 🎉");
  console.log("==>");
  console.log("==> ///////////////////////////////////////////////");
  console.log("==>");
  console.log("==> Available at your primary URL https://barber-ai.onrender.com");
  console.log("==>");
  console.log("==> ///////////////////////////////////////////////");
});
