import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL || "https://barber-ai.onrender.com";

const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    const twiml = `
      <Response>
        <Say voice="alice">Connecting you to Barber A I.</Say>
        <Connect>
          <Stream url="${BASE_URL.replace(/^https?/, "wss")}/media" track="both_tracks" />
        </Connect>
      </Response>
    `.trim();

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml);
  }

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
  let twilioReady = false;
  let currentResponseId = null;
  let streamSid = null;
  let isSpeaking = false;
  let awaitingCancel = false;
  let awaitingResponse = false;
  let activeResponse = false;
  let vadSpeechStartMs = null;
  const pendingAudio = [];

  // barge-in helpers (unchanged)
  let mutedTTS = false;
  let bargeTimer = null;
  const CANCEL_AFTER_MS = 75;
  let lastCreateTs = 0;
  const CREATE_DEBOUNCE_MS = 600;

  const safeSendTwilio = (msgObj) => {
    if (!twilioReady || !streamSid) {
      if (msgObj?.event === "media") pendingAudio.push(msgObj);
      return;
    }
    if (msgObj?.event === "media" && !msgObj.streamSid) {
      msgObj.streamSid = streamSid;
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
      safeSendTwilio(frame);
    }
  };

  // ---- send assistant audio to Twilio OUTBOUND in ~20ms μ-law frames ----
  function sendToTwilioOut(base64Audio) {
    if (!base64Audio) return;
    const buf = Buffer.from(base64Audio, "base64");
    for (let i = 0; i < buf.length; i += 160) { // 160 bytes ≈ 20ms @ 8k μ-law
      const chunk = buf.subarray(i, i + 160).toString("base64");
      safeSendTwilio({
        event: "media",
        streamSid,
        media: { track: "outbound", payload: chunk },
      });
    }
    // optional mark for your logs
    safeSendTwilio({ event: "mark", streamSid, mark: { name: "chunk" } });
  }

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

  let openaiOutbox = [];
  const safeSendOpenAI = (objOrString) => {
    const data =
      typeof objOrString === "string" ? objOrString : JSON.stringify(objOrString);
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
    safeSendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw",
        input_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.35,
          silence_duration_ms: 350,
          prefix_padding_ms: 150,
        },
        instructions:
          "You are Barber AI. Always speak concise US English for phone calls.",
      },
    });

    while (openaiOutbox.length) openaiWS.send(openaiOutbox.shift());
  });

  // Forward OpenAI audio -> Twilio
  openaiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!["response.output_audio.delta", "error"].includes(msg.type)) {
        console.log("[OpenAI EVENT]", msg.type, JSON.stringify(msg).slice(0, 400));
      }

      if (
        (msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta") &&
        (msg.audio || msg.delta)
      ) {
        isSpeaking = true;
        if (!mutedTTS) {
          const payload = msg.audio || msg.delta;
          sendToTwilioOut(payload); // ✅ send as outbound frames
        }
      } else if (msg.type === "response.created") {
        activeResponse = true;
        awaitingResponse = false;
        currentResponseId = msg.response?.id || currentResponseId;
      } else if (
        msg.type === "response.audio.done" ||
        msg.type === "response.canceled" ||
        msg.type === "response.done"
      ) {
        isSpeaking = false;
        awaitingCancel = false;
        activeResponse = false;
        awaitingResponse = false;
        currentResponseId = null;
        mutedTTS = false;
        if (bargeTimer) {
          clearTimeout(bargeTimer);
          bargeTimer = null;
        }
      } else if (msg.type === "input_audio_buffer.speech_started") {
        vadSpeechStartMs = msg.audio_start_ms ?? Date.now();
        if (activeResponse && isSpeaking && !awaitingCancel && currentResponseId) {
          safeSendOpenAI({ type: "response.cancel", response_id: currentResponseId });
          awaitingCancel = true;
        }
      } else if (msg.type === "input_audio_buffer.speech_stopped") {
        const durMs = (msg.audio_end_ms ?? 0) - (vadSpeechStartMs ?? 0);
        vadSpeechStartMs = null;
        if (durMs < 700) {
          safeSendOpenAI({ type: "input_audio_buffer.clear" });
          return;
        }
        if (!awaitingResponse && !activeResponse) {
          safeSendOpenAI({
            type: "response.create",
            response: { modalities: ["audio", "text"], conversation: "auto" },
          });
          awaitingResponse = true;
        }
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

      if (msg.event === "media") {
        const track = msg.media?.track || msg.track;
        if (track && track !== "inbound") return;

        const b64 = msg.media?.payload;
        if (b64) {
          safeSendOpenAI({ type: "input_audio_buffer.append", audio: b64 });
        }
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
        flushPendingAudio?.();

        // Greeting
        safeSendOpenAI({
          type: "response.create",
          response: {
            instructions:
              "Say exactly: 'Hello thank you for calling the barber shop. How can I help you today.'",
            modalities: ["audio", "text"],
            conversation: "none",
          },
        });
        awaitingResponse = true;
        return;
      }

      if (msg.event === "mark") {
        console.log("[Twilio] mark received:", msg?.mark?.name);
        return;
      }

      if (msg.event === "stop") {
        console.log("[Twilio] stop");
        safeClose(openaiWS);
        safeClose(twilioWS);
        return;
      }
    } catch (e) {
      console.error("Twilio message parse error", e);
    }
  });

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
