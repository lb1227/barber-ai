// server.js
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * ENV
 * - OPENAI_API_KEY (required)
 * - PORT (default 10000)
 * - BASE_URL (e.g. https://barber-ai.onrender.com)
 * - OPENAI_REALTIME_MODEL (default gpt-4o-realtime-preview)
 */
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const BASE_URL = process.env.BASE_URL || "https://barber-ai.onrender.com";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

// ---------- Crash visibility ----------
process.on("uncaughtException", (err) => console.error("[Uncaught]", err));
process.on("unhandledRejection", (err) => console.error("[Unhandled]", err));

// ---------- HTTP server (TwiML + health) ----------
const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    // Stream *inbound* audio only. We synthesize to Twilio via media frames we send back.
    // No <Say> to avoid speaking before we’re ready.
    const twiml = `
      <Response>
        <Connect>
          <Stream url="${BASE_URL.replace(/^https?/, "wss")}/media" track="inbound_track"/>
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

// ---------- WS upgrade ----------
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  console.log(
    "[UPGRADE]",
    req.url,
    "ua=",
    req.headers["user-agent"],
    "xfwd=",
    req.headers["x-forwarded-for"]
  );
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---------- Helpers: μ-law decode + RMS ----------
function muLawByteToPcm16(u) {
  // μ-law decode (G.711) – returns int16
  // Source logic adapted from common G711 tables (no external deps).
  u = ~u & 0xff;
  const sign = u & 0x80;
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= 0x84; // bias
  return sign ? -sample : sample;
}

function rmsOfMuLawBase64(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    const len = buf.length;
    if (!len) return 0;
    let sumSq = 0;
    // Sample μ-law bytes sparsely if very large to save CPU
    const stride = len > 3200 ? Math.floor(len / 1600) : 1;
    let count = 0;
    for (let i = 0; i < len; i += stride) {
      const s = muLawByteToPcm16(buf[i]);
      sumSq += s * s;
      count++;
    }
    const meanSq = sumSq / Math.max(1, count);
    // Normalize to ~0..1 from int16
    return Math.sqrt(meanSq) / 32768;
  } catch {
    return 0;
  }
}

// ---------- Conversation policies (tunable) ----------
const VAD = {
  // Audio sampled at 8kHz in G.711 μ-law
  FRAME_MS: 20, // Twilio sends ~20ms media frames
  // Speech detection:
  RMS_START: 0.02, // start speaking threshold (~-34 dBFS)
  RMS_CONTINUE: 0.015, // keep speaking threshold
  MIN_SPEECH_MS: 80, // require at least this much speech before we consider it a user turn
  END_SILENCE_MS: 700, // end of utterance silence
  // Barge-in:
  BARGE_IN_MIN_MS: 100, // must detect this much speech before canceling assistant
  // Idle:
  MAX_TURN_DURATION_MS: 6000, // fallback end to avoid never-ending capture
};

const INSTRUCTIONS =
  "You are Barber AI, a phone receptionist. STRICT RULES:\n" +
  "1) Respond ONLY in clear American English.\n" +
  "2) If the caller is not speaking English, say exactly once: 'Sorry—I only speak English.' Then remain silent until you detect English.\n" +
  "3) Do NOT reply to background noise, music, tones, or non-speech. Stay silent unless you detect human speech in English.\n" +
  "4) Be concise and professional. No backchannels. Stop speaking immediately if interrupted.\n" +
  "5) Never start a conversation on your own. Only respond after the caller has spoken English.";

// ---------- Main bridge ----------
wss.on("connection", (twilioWS) => {
  console.log("[Twilio] connected");

  // Twilio state
  let twilioReady = false;
  let streamSid = null;

  // OpenAI WS
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

  // Send helpers
  const safeSendTwilio = (msgObj) => {
    if (!twilioReady || !streamSid) return;
    if (msgObj?.event === "media" && !msgObj.streamSid) msgObj.streamSid = streamSid;
    if (twilioWS.readyState === WebSocket.OPEN) {
      try {
        twilioWS.send(JSON.stringify(msgObj));
      } catch (err) {
        console.error("[Twilio send error]", err);
      }
    }
  };

  const openaiOutbox = [];
  const safeSendOpenAI = (obj) => {
    const data = typeof obj === "string" ? obj : JSON.stringify(obj);
    if (openaiWS.readyState === WebSocket.OPEN) {
      try {
        openaiWS.send(data);
      } catch (e) {
        console.error("[OpenAI send error]", e);
      }
    } else {
      openaiOutbox.push(data);
    }
  };

  // ---- Turn & VAD state machine ----
  let isAssistantSpeaking = false;
  let awaitingResponse = false; // a response.create is in flight
  let userSpeechActive = false;
  let userSpeechMs = 0;
  let silenceMs = 0;
  let turnMs = 0;

  let collectedBytes = 0; // for commit size debug only
  let capturedFrames = []; // store base64 frames for this user turn

  function resetUserCapture() {
    userSpeechActive = false;
    userSpeechMs = 0;
    silenceMs = 0;
    turnMs = 0;
    collectedBytes = 0;
    capturedFrames = [];
  }

  function appendUserAudio(b64) {
    // Compute RMS for VAD
    const level = rmsOfMuLawBase64(b64);

    // Decide state transition
    if (!userSpeechActive) {
      if (level >= VAD.RMS_START) {
        userSpeechActive = true;
        userSpeechMs = VAD.FRAME_MS;
        silenceMs = 0;
      } else {
        // still idle/noise; do not store audio
        return;
      }
    } else {
      // already in speech
      if (level >= VAD.RMS_CONTINUE) {
        userSpeechMs += VAD.FRAME_MS;
        silenceMs = 0;
      } else {
        // below continue threshold, count as silence
        silenceMs += VAD.FRAME_MS;
      }
    }

    // If we're actively capturing, store the frame (even if it's low-level, once in speech)
    capturedFrames.push(b64);
    collectedBytes += Buffer.from(b64, "base64").length;
    turnMs += VAD.FRAME_MS;

    // Barge-in: only if assistant is speaking AND we've confirmed speech ≥ BARGE_IN_MIN_MS
    if (
      isAssistantSpeaking &&
      userSpeechMs >= VAD.BARGE_IN_MIN_MS &&
      !awaitingResponse
    ) {
      console.log("[BARGE-IN] Canceling assistant due to user speech");
      safeSendOpenAI({ type: "response.cancel" });
      isAssistantSpeaking = false;
    }

    // End-of-utterance?
    const utteranceLongEnough = userSpeechMs >= VAD.MIN_SPEECH_MS;
    const endedBySilence = silenceMs >= VAD.END_SILENCE_MS;
    const endedByTimeout = turnMs >= VAD.MAX_TURN_DURATION_MS;

    if ((utteranceLongEnough && endedBySilence) || endedByTimeout) {
      // Build a single base64 by concatenation (OpenAI accepts incremental appends;
      // we’ll just append frames then commit once)
      for (const f of capturedFrames) {
        safeSendOpenAI({ type: "input_audio_buffer.append", audio: f });
      }
      safeSendOpenAI({ type: "input_audio_buffer.commit" });

      // Create assistant response (audio + text)
      awaitingResponse = true;
      console.log(
        `[TURN] committing: ${capturedFrames.length} frames, ${collectedBytes} bytes`
      );
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "auto",
          instructions:
      "Respond ONLY in American English. If the last user speech was not English, reply once with 'Sorry—I only speak English.' then stay silent until English is detected. Keep replies brief.",
        },
      });

      // Clear capture for next turn
      resetUserCapture();
    }
  }

  // ---------- OpenAI socket ----------
  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");
    // Configure to be *reactive only*; we do our own VAD and turn-taking.
    safeSendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw", // matches Twilio playback
        input_audio_format: "g711_ulaw", // we send μ-law to the buffer
        // IMPORTANT: no server VAD; we control commits.
        instructions: INSTRUCTIONS,
      },
    });

    // flush queued messages if any
    while (openaiOutbox.length) openaiWS.send(openaiOutbox.shift());
  });

  openaiWS.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error("[OpenAI] parse error");
      return;
    }

    // Log selectively
    if (!["response.output_audio.delta", "response.audio.delta"].includes(msg.type)) {
      console.log("[OpenAI EVENT]", msg.type);
    }

    if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
      // Assistant is speaking → stream to Twilio
      isAssistantSpeaking = true;
      const payload = msg.audio || msg.delta; // base64 μ-law
      safeSendTwilio({ event: "media", media: { payload } });
    } else if (msg.type === "response.audio.done") {
      isAssistantSpeaking = false;
    } else if (msg.type === "response.done") {
      isAssistantSpeaking = false;
      awaitingResponse = false;
      // ensure we clear the model input buffer after each turn (defensive)
      safeSendOpenAI({ type: "input_audio_buffer.clear" });
    } else if (msg.type === "error") {
      console.error("[OpenAI ERROR]", msg);
    }
  });

  // ---------- Twilio inbound ----------
  twilioWS.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Twilio message parse error", e);
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      twilioReady = true;
      console.log("[Twilio] stream started", streamSid, "tracks:", msg.start.tracks);
      resetUserCapture();
      return;
    }

    if (msg.event === "media") {
      const b64 = msg.media?.payload;
      if (!b64) return;

      // While assistant is speaking, we still collect audio for barge-in detection.
      // But we will NOT start a new response while `awaitingResponse` is true.
      appendUserAudio(b64);
      return;
    }

    if (msg.event === "mark") return;

    if (msg.event === "stop") {
      console.log("[Twilio] stop");
      safeClose(openaiWS);
      safeClose(twilioWS);
      return;
    }
  });

  // ---------- Closures & errors ----------
  twilioWS.on("close", () => {
    console.log("[Twilio] closed");
    safeClose(openaiWS);
  });
  openaiWS.on("close", () => {
    console.log("[OpenAI] closed");
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
