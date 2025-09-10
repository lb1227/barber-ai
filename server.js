import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/* ---------- config ---------- */
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const BASE_URL = process.env.BASE_URL || "https://barber-ai.onrender.com"; // your https render url
const WSS_URL = BASE_URL.replace(/^https?/, "wss"); // -> wss://.../media

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

/* ---------- server: /voice TwiML + health ---------- */
const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    // Bidirectional stream so Twilio both sends mic audio and plays our audio
    const twiml = `
      <Response>
        <Connect>
          <Stream url="${WSS_URL}/media" track="both_tracks"/>
        </Connect>
      </Response>
    `.trim();

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml);
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Barber AI Realtime bridge is alive.\n");
});

server.on("request", (req) => {
  console.log("[HTTP]", req.method, req.url, "ua=", req.headers["user-agent"]);
});

/* ---------- WS upgrade ---------- */
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  console.log("[UPGRADE]", req.url, "ua=", req.headers["user-agent"], "xfwd=", req.headers["x-forwarded-for"]);
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

/* ==========================================================
   Per-call bridge: Twilio <-> OpenAI Realtime
   ========================================================== */
wss.on("connection", (twilioWS) => {
  console.log("[Twilio] connected");

  /* ---- minimal state ---- */
  let streamSid = null;
  let isSpeaking = false;        // OpenAI is currently sending audio
  let awaitingResponse = false;  // a response is in-flight
  let awaitingCancel = false;    // cancel sent, waiting for OpenAI to stop
  let inboundBytes = 0;          // accumulated inbound audio (for commit)
  let pendingCommit = false;     // mark that we appended and need to check commit timer

  // Barge-in meter (to distinguish real caller from echo)
  let bargeBytes = 0;
  let bargeFrames = 0;
  let bargeResetTimer = null;
  const resetBarge = () => {
    bargeBytes = 0;
    bargeFrames = 0;
    if (bargeResetTimer) { clearTimeout(bargeResetTimer); bargeResetTimer = null; }
  };

  /* ---- helpers ---- */
  const safeClose = (ws) => { try { ws?.readyState === WebSocket.OPEN && ws.close(); } catch {} };

  const safeSendTwilio = (obj) => {
    if (!obj) return;
    if (obj.event === "media" && streamSid && !obj.streamSid) obj.streamSid = streamSid;
    if (twilioWS.readyState === WebSocket.OPEN) {
      try { twilioWS.send(JSON.stringify(obj)); } catch (e) { console.error("[Twilio send error]", e); }
    }
  };

  /* ---------- OpenAI Realtime WS ---------- */
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        "x-openai-audio-output-format": "g711_ulaw", // Twilio-friendly
      },
    }
  );

  const sendOpenAI = (obj) => {
    try {
      openaiWS.readyState === WebSocket.OPEN
        ? openaiWS.send(JSON.stringify(obj))
        : console.warn("[OpenAI] send when not OPEN:", obj?.type);
    } catch (e) { console.error("[OpenAI send error]", e); }
  };

  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");
    sendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw",
        input_audio_format: "g711_ulaw",
        // Stricter VAD to resist echo; still responsive
        turn_detection: {
          type: "server_vad",
          threshold: 0.75,
          silence_duration_ms: 650,
          prefix_padding_ms: 200,
        },
        instructions: "You are Barber AI. Speak concise US English for phone calls.",
      },
    });

    // Optional tiny greeting (remove if you don't want it)
    awaitingResponse = true;
    sendOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        conversation: "none",
        instructions: "Hi! You're connected to Barber AI. How can I help?",
      },
    });
  });

  /* ---------- OpenAI -> Twilio (audio out) ---------- */
  openaiWS.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case "response.audio.delta":
      case "response.output_audio.delta": {
        isSpeaking = true;
        const payload = msg.audio || msg.delta; // base64 μ-law
        safeSendTwilio({ event: "media", media: { payload } });
        if (streamSid) safeSendTwilio({ event: "mark", streamSid, mark: { name: "chunk" } });
        break;
      }
      case "response.audio.done":
        isSpeaking = false;
        awaitingCancel = false;
        resetBarge();
        break;
      case "response.canceled":
        isSpeaking = false;
        awaitingCancel = false;
        resetBarge();
        break;
      case "response.done":
        isSpeaking = false;
        awaitingCancel = false;
        awaitingResponse = false;
        resetBarge();
        break;
      case "error":
        console.error("[OpenAI ERROR]", msg);
        break;
      default:
        // verbose events trimmed
        break;
    }
  });

  /* ---------- Twilio -> OpenAI (audio in) ---------- */
  twilioWS.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { console.error("[Twilio parse error]", e); return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("[Twilio] start:", streamSid, "tracks:", msg.start?.tracks);
      return;
    }

    if (msg.event === "stop") {
      console.log("[Twilio] stop");
      safeClose(openaiWS);
      safeClose(twilioWS);
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      const byteLen = payload ? Buffer.from(payload, "base64").length : 0;

      // ---- Smart half-duplex with barge-in ----
      if (isSpeaking) {
        // accumulate while bot is talking; ignore tiny echo
        bargeBytes += byteLen;
        bargeFrames += 1;
        if (!bargeResetTimer) bargeResetTimer = setTimeout(resetBarge, 800);

        const FRAMES_OK = bargeFrames >= 15; // ≈300ms (20ms/frame)
        const BYTES_OK  = bargeBytes  >= 4000; // ≈>4KB
        if (FRAMES_OK && BYTES_OK && !awaitingCancel) {
          // caller is speaking over the bot -> stop TTS and clear buffered echo
          sendOpenAI({ type: "response.cancel" });
          awaitingCancel = true;
          sendOpenAI({ type: "input_audio_buffer.clear" });
          resetBarge();
        }
        return; // swallow echo frames while speaking
      }

      // Normal path: append caller audio for VAD/ASR
      if (payload) {
        inboundBytes += byteLen;
        sendOpenAI({ type: "input_audio_buffer.append", audio: payload });
        pendingCommit = true;
        startCommitTimerIfNeeded();
      }
      return;
    }
  });

  /* ---------- commit buffering -> create response ---------- */
  const COMMIT_BYTES = 2000; // ~200–250ms μ-law
  const TICK_MS = 150;
  let commitTimer = null;

  function startCommitTimerIfNeeded() {
    if (commitTimer) return;
    commitTimer = setInterval(() => {
      if (!pendingCommit) return;
      if (openaiWS.readyState !== WebSocket.OPEN) return;
      if (isSpeaking) return;            // don't commit while we're talking
      if (awaitingResponse) return;      // wait until last turn is done
      if (inboundBytes < COMMIT_BYTES) return;

      // commit current buffer and ask for a response
      sendOpenAI({ type: "input_audio_buffer.commit" });
      sendOpenAI({ type: "response.create", response: { modalities: ["audio", "text"], conversation: "auto" } });
      awaitingResponse = true;
      inboundBytes = 0;
      pendingCommit = false;
    }, TICK_MS);
  }

  function stopCommitTimer() {
    if (commitTimer) { clearInterval(commitTimer); commitTimer = null; }
  }

  /* ---------- lifecycle ---------- */
  twilioWS.on("close", () => {
    console.log("[Twilio] closed");
    stopCommitTimer();
    safeClose(openaiWS);
  });
  openaiWS.on("close", () => {
    console.log("[OpenAI] closed");
    stopCommitTimer();
    safeClose(twilioWS);
  });
  twilioWS.on("error", (e) => console.error("[Twilio WS error]", e));
  openaiWS.on("error", (e) => console.error("[OpenAI WS error]", e));
});

/* ---------- boot ---------- */
process.on("uncaughtException", (e) => console.error("[Uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[Unhandled]", e));

server.listen(PORT, () => {
  console.log(`Minimal WS server ready at http://0.0.0.0:${PORT}`);
});
