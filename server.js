// server.js — Twilio <-> OpenAI Realtime (g711 μ-law) telephony bridge
// Env: OPENAI_API_KEY (and optionally OPENAI_MODEL)
// TwiML <Connect><Stream url="wss://<your-app>/media" /></Connect>

const http = require("http");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// μ-law @ 8kHz: 1 byte per sample => ~8 bytes/ms
const SAMPLE_RATE = 8000;
const BYTES_PER_MS = SAMPLE_RATE / 1000; // 8
const COMMIT_MS = 120; // >= 100ms to satisfy Realtime minimum nicely
const MIN_BYTES_PER_COMMIT = Math.ceil(BYTES_PER_MS * COMMIT_MS); // ~960

const app = express();
app.get("/", (_req, res) => res.status(200).send("OK"));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function b64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
}
function joinBuffers(parts) {
  if (!parts.length) return Buffer.alloc(0);
  return Buffer.concat(parts, parts.reduce((n,b)=>n+b.length,0));
}

wss.on("connection", (twilioWS) => {
  let streamSid = null;

  // Buffer inbound Twilio μ-law
  let inboundChunks = [];
  let lastFlush = Date.now();

  // OpenAI Realtime WS
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Flush >=100ms μ-law to OpenAI (append+commit)
  const flushTimer = setInterval(() => {
    if (oaWS.readyState !== WebSocket.OPEN) return;

    const elapsed = Date.now() - lastFlush;
    const totalBytes = inboundChunks.reduce((n, b) => n + b.length, 0);

    // Only flush if we actually have >=100ms audio AND the interval elapsed
    if (totalBytes >= MIN_BYTES_PER_COMMIT && elapsed >= COMMIT_MS) {
      const buf = joinBuffers(inboundChunks);
      inboundChunks = [];
      lastFlush = Date.now();

      // Append μ-law audio
      oaWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: b64(buf)
        // session.input_audio_format is already g711_ulaw, so we don't
        // need to restate it here.
      }));

      // Commit ONLY after we appended bytes
      oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  }, Math.max(20, COMMIT_MS / 2));

  function sendToTwilioUlaw(base64Payload) {
    if (twilioWS.readyState !== WebSocket.OPEN || !streamSid) return;
    safeSend(twilioWS, {
      event: "media",
      streamSid,
      media: { payload: base64Payload },
    });
  }

  // ---------- Twilio WS ----------
  twilioWS.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    const { event } = data;

    if (event === "start") {
      streamSid = data.start?.streamSid || data.streamSid;
      console.log("[Twilio] START", { streamSid });
      return;
    }

    if (event === "media") {
      const payload = data.media?.payload;
      if (payload) inboundChunks.push(Buffer.from(payload, "base64"));
      return;
    }

    if (event === "stop") {
      console.log("[Twilio] STOP", { streamSid });
      try { twilioWS.close(1000); } catch {}
      try { oaWS.close(1000); } catch {}
      return;
    }
  });

  twilioWS.on("close", () => {
    clearInterval(flushTimer);
    try { oaWS.close(1000); } catch {}
  });
  twilioWS.on("error", (e) => console.error("[Twilio] WS error", e));

  // keep-alive marks so Twilio doesn't close early
  const markTimer = setInterval(() => {
    if (twilioWS.readyState === WebSocket.OPEN && streamSid) {
      safeSend(twilioWS, { event: "mark", streamSid, mark: { name: "alive" } });
    }
  }, 5000);
  twilioWS.on("close", () => clearInterval(markTimer));

  // ---------- OpenAI WS ----------
  oaWS.on("open", () => {
    console.log("[OpenAI] WS open");

    // Configure μ-law in/out + voice + system instructions
    oaWS.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "verse",
        instructions:
          "You are a friendly barber shop assistant. Answer briefly and naturally. Ask helpful follow-up questions when needed."
      },
    }));

    // Immediate greeting (NOTE: 'audio' must be TOP-LEVEL, not inside 'response')
    oaWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hi! Thanks for calling the barbershop, how can I help you today?"
      },
      audio: { voice: "verse" }
    }));
  });

  oaWS.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    switch (evt.type) {
      case "response.output_audio.delta":
        if (evt.delta) sendToTwilioUlaw(evt.delta);
        break;

      case "output_audio_buffer.append":
        if (evt.audio) sendToTwilioUlaw(evt.audio);
        break;

      case "response.completed":
        // you can queue another response here if you want
        break;

      case "error":
        console.error("[OpenAI ERROR]", evt);
        break;
    }
  });

  oaWS.on("close", (code, reason) => {
    console.log("[OpenAI] WS closed", code, reason?.toString?.());
    try { twilioWS.close(1000); } catch {}
  });
  oaWS.on("error", (e) => console.error("[OpenAI] WS error", e));
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
