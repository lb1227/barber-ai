// server.js (ESM)
// Advanced Twilio <-> OpenAI Realtime bridge with robust barge-in & echo safeguards.

import http from "http";
import { WebSocketServer, WebSocket } from "ws";

// -------------------------- ENV ---------------------------------------------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const BASE_URL = process.env.BASE_URL || "https://barber-ai.onrender.com";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

// ----------------------- CRASH VISIBILITY -----------------------------------
process.on("uncaughtException", (e) => console.error("[Uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[Unhandled]", e));

// ----------------------- TWIML HTTP SERVER ----------------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    // IMPORTANT: Only stream inbound (caller) audio to avoid hearing ourselves.
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

  // health
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Barber AI Realtime bridge is alive.\n");
});

server.on("request", (req) => {
  console.log("[HTTP]", req.method, req.url, "ua=", req.headers["user-agent"]);
});

// --------------------------- WS UPGRADE -------------------------------------
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

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

// ------------------------ AUDIO / VAD HELPERS -------------------------------
// μ-law to PCM16 decode (fast inline)
function mulawByteToPcm16(u) {
  // G.711 μ-law decode
  u = ~u & 0xff;
  const sign = u & 0x80;
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84 << exponent;
  return sign ? -sample : sample;
}

// Compute RMS of a μ-law base64 payload
function ulawBase64Rms(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0) return 0;
    let acc = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = mulawByteToPcm16(buf[i]);
      acc += s * s;
    }
    const meanSq = acc / buf.length;
    return Math.sqrt(meanSq); // 0..~32124
  } catch {
    return 0;
  }
}

// Adaptive VAD with noise floor tracking
class AdaptiveVad {
  constructor({
    minRms = 800, // absolute floor (tune if needed)
    noiseLearnFrames = 50, // learn baseline during early silence frames
    boost = 3.5, // threshold multiplier over noise floor
  } = {}) {
    this.minRms = minRms;
    this.noiseLearnFrames = noiseLearnFrames;
    this.boost = boost;
    this.learned = 0;
    this.noiseSum = 0;
    this.noiseFloor = minRms / 2;
  }
  observe(rms, consideredSilent) {
    if (consideredSilent && this.learned < this.noiseLearnFrames) {
      this.noiseSum += rms;
      this.learned++;
      this.noiseFloor = Math.max(200, this.noiseSum / this.learned);
    }
  }
  isSpeech(rms) {
    const dyn = Math.max(this.minRms, this.noiseFloor * this.boost);
    return rms >= dyn;
  }
}

// ----------------------------- CONNECTION -----------------------------------
wss.on("connection", (twilioWS) => {
  console.log("[Twilio] connected");

  // -------------------- STATE & CONSTANTS -----------------------------------
  // Timings (ms)
  const FRAME_MS = 20; // Twilio sends ~20ms frames at 8kHz
  const ECHO_MUTE_WINDOW_MS = 600; // ignore inbound right after we start speaking (echo guard)
  const BARGE_MIN_SPEECH_MS = 320; // sustained caller speech to count as interruption
  const EOS_SILENCE_MS = 450; // end-of-speech silence to commit
  const MAX_UTTERANCE_MS = 4000; // force commit if long monologue
  const MIN_COMMIT_BYTES = 1600; // also gate on bytes (~>100ms of µ-law)

  // VAD
  const vad = new AdaptiveVad({ minRms: 800, noiseLearnFrames: 100, boost: 3.8 });

  // Flags
  let twilioReady = false;
  let streamSid = null;

  // Speaking / listening state
  let isSpeaking = false; // we are currently playing TTS to caller
  let awaitingCancel = false; // cancel in-flight
  let awaitingResponse = false; // model response in flight
  let greetingInFlight = false; // first turn

  // Scheduler counters
  let lastOutboundTs = 0; // last time we sent any TTS audio to Twilio
  let echoMuteUntil = 0; // absolute time until which inbound frames are discarded (echo)
  let collecting = false; // currently collecting a caller utterance
  let collectedMs = 0; // collected speech duration
  let collectedBytes = 0; // for safety gating
  let silenceMs = 0; // silence stretch after speech
  let totalSinceLastCommitMs = 0;

  // Twilio media buffering (only used until streamSid available)
  const pendingAudioOut = [];

  // Heartbeat (keeps WS from idling)
  const heartbeat = setInterval(() => {
    try {
      if (twilioWS.readyState === WebSocket.OPEN) twilioWS.ping();
      if (openaiWS.readyState === WebSocket.OPEN) openaiWS.ping();
    } catch {}
  }, 15000);

  const safeSendTwilio = (obj) => {
    if (!obj) return;
    if (!twilioReady || !streamSid) {
      if (obj.event === "media") pendingAudioOut.push(obj);
      return;
    }
    if (obj.event === "media" && !obj.streamSid) obj.streamSid = streamSid;
    if (twilioWS.readyState === WebSocket.OPEN) {
      try {
        twilioWS.send(JSON.stringify(obj));
      } catch (e) {
        console.error("[Twilio send error]", e);
      }
    }
  };
  const flushPendingTwilio = () => {
    while (pendingAudioOut.length && twilioWS.readyState === WebSocket.OPEN) {
      const frame = pendingAudioOut.shift();
      safeSendTwilio(frame);
    }
  };

  // ---------------------- OPENAI REALTIME SOCKET ----------------------------
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

  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");
    // We implement our own end-of-speech detection; leave turn_detection off.
    safeSendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw",
        input_audio_format: "g711_ulaw",
        // no turn_detection — we control commit explicitly
        instructions:
          "You are Barber AI. Speak in concise US English. Do not interrupt. If the caller interrupts, stop and listen.",
      },
    });
    while (openaiOutbox.length) {
      openaiWS.send(openaiOutbox.shift());
    }
  });

  // ----------------------- FSM HELPERS --------------------------------------
  function onTtsStart() {
    isSpeaking = true;
    lastOutboundTs = Date.now();
    echoMuteUntil = lastOutboundTs + ECHO_MUTE_WINDOW_MS; // echo guard window
  }
  function onTtsStop() {
    isSpeaking = false;
    awaitingCancel = false;
    // leave echoMuteUntil as-is; VAD will ignore if time has passed
  }

  function startCollecting() {
    collecting = true;
    collectedMs = 0;
    collectedBytes = 0;
    silenceMs = 0;
    totalSinceLastCommitMs = 0;
  }
  function stopCollecting() {
    collecting = false;
    collectedMs = 0;
    collectedBytes = 0;
    silenceMs = 0;
  }

  function commitAndAsk() {
    // Finalize the current audio buffer and ask for a response
    safeSendOpenAI({ type: "input_audio_buffer.commit" });
    safeSendOpenAI({
      type: "response.create",
      response: { modalities: ["audio", "text"], conversation: "auto" },
    });
    awaitingResponse = true;
    stopCollecting();
  }

  function handleBargeIn() {
    if (isSpeaking && awaitingResponse && !awaitingCancel) {
      // True human barge-in — cancel TTS immediately
      safeSendOpenAI({ type: "response.cancel" });
      awaitingCancel = true;
    }
    // We also begin collecting the caller speech (frames already being appended)
    if (!collecting) startCollecting();
  }

  // ------------------ OPENAI -> TWILIO (OUTBOUND AUDIO) ---------------------
  openaiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case "response.output_audio.delta":
        case "response.audio.delta": {
          const payload = msg.delta || msg.audio; // base64 G.711 μ-law
          if (payload) {
            onTtsStart();
            safeSendTwilio({ event: "media", media: { payload } });
            if (streamSid) {
              safeSendTwilio({
                event: "mark",
                streamSid,
                mark: { name: "chunk" },
              });
            }
          }
          break;
        }
        case "response.audio.done": {
          onTtsStop();
          break;
        }
        case "response.canceled": {
          onTtsStop();
          break;
        }
        case "response.done": {
          onTtsStop();
          awaitingResponse = false;
          if (greetingInFlight) {
            greetingInFlight = false;
            console.log("[State] greeting done");
          }
          break;
        }
        case "error": {
          console.error("[OpenAI ERROR]", msg);
          break;
        }
        default: {
          // Throttle logs: show interesting events only
          if (!String(msg.type).includes("rate_limits"))
            console.log("[OpenAI EVENT]", msg.type);
        }
      }
    } catch (e) {
      console.error("OpenAI message parse error", e);
    }
  });

  // ------------------ TWILIO -> OPENAI (INBOUND AUDIO) ----------------------
  twilioWS.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Sometimes toolchains inject noise; ignore non-JSON frames.
      return;
    }

    if (msg.event === "start") {
      console.log(
        "[Twilio] stream start:",
        msg.start.streamSid,
        "tracks:",
        msg.start.tracks
      );
      streamSid = msg.start.streamSid;
      twilioReady = true;
      flushPendingTwilio();

      // Initial greeting (one-time)
      greetingInFlight = true;
      awaitingResponse = true;
      safeSendOpenAI({
        type: "response.create",
        response: {
          instructions:
            "Say exactly: 'Hello from Barber AI. If you can hear this, the OpenAI link works.'",
          modalities: ["audio", "text"],
          conversation: "none",
        },
      });
      return;
    }

    if (msg.event === "media") {
      const b64 = msg.media?.payload;
      if (!b64) return;

      // 1) Compute energy & update VAD/noise
      const now = Date.now();
      const rms = ulawBase64Rms(b64);

      // Considered silent for learning if very low RMS and not in speaking echo window
      const inEchoWindow = now < echoMuteUntil;
      const consideredSilent = rms < 400; // tiny baseline for learning
      vad.observe(rms, consideredSilent && !inEchoWindow);

      const speechy = vad.isSpeech(rms);

      // 2) Decide whether to treat as barge-in or discard as echo
      if (isSpeaking) {
        // If we're talking, ignore frames during echo mute window unless strong sustained speech appears
        if (inEchoWindow) {
          // DROP: do not append
          return;
        }

        // Outside mute window: only count as barge-in if sustained speech
        // We implement a tiny accumulator by toggling collecting based on speechy
        if (speechy) {
          if (!collecting) startCollecting();
          collectedMs += FRAME_MS;
          if (collectedMs >= BARGE_MIN_SPEECH_MS) {
            handleBargeIn(); // will cancel TTS
          }
        } else {
          // brief non-speech resets small accumulator
          if (collecting) {
            collectedMs = Math.max(0, collectedMs - 2 * FRAME_MS);
          }
        }

        // Do NOT forward frames to OpenAI while we are speaking until barge-in confirmed (collecting long enough)
        if (!(collecting && collectedMs >= BARGE_MIN_SPEECH_MS)) {
          return; // drop likely echo / short spurts
        }
      }

      // 3) We are either not speaking, or barge-in is confirmed — append audio
      safeSendOpenAI({ type: "input_audio_buffer.append", audio: b64 });

      // mark collecting state & track totals
      if (!collecting) startCollecting();
      collectedBytes += Buffer.from(b64, "base64").length;
      totalSinceLastCommitMs += FRAME_MS;

      // 4) End-of-speech detection (silence stretch)
      if (speechy) {
        silenceMs = 0;
      } else {
        silenceMs += FRAME_MS;
      }

      const longEnough =
        collectedBytes >= MIN_COMMIT_BYTES ||
        collectedMs >= (BARGE_MIN_SPEECH_MS + 80);

      const hitEos = longEnough && silenceMs >= EOS_SILENCE_MS;
      const hitMax = totalSinceLastCommitMs >= MAX_UTTERANCE_MS;

      if (hitEos || hitMax) {
        commitAndAsk();
      }

      return;
    }

    if (msg.event === "mark") {
      // debugging
      // console.log("[Twilio] mark:", msg?.mark?.name);
      return;
    }

    if (msg.event === "stop") {
      console.log("[Twilio] stop");
      cleanupAndClose();
      return;
    }
  });

  // --------------------------- CLEANUP --------------------------------------
  function cleanupAndClose() {
    clearInterval(heartbeat);
    try {
      if (openaiWS.readyState === WebSocket.OPEN) openaiWS.close();
    } catch {}
    try {
      if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close();
    } catch {}
  }

  twilioWS.on("close", () => {
    console.log("[Twilio] closed");
    cleanupAndClose();
  });
  openaiWS.on("close", () => {
    console.log("[OpenAI] closed");
    cleanupAndClose();
  });

  twilioWS.on("error", (e) => console.error("[Twilio WS error]", e));
  openaiWS.on("error", (e) => console.error("[OpenAI WS error]", e));
});

// --------------------------- BOOT -------------------------------------------
server.listen(PORT, () => {
  console.log(`Advanced WS server ready at http://0.0.0.0:${PORT}`);
});
