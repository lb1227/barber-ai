// server.js
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { getAuthUrl, handleOAuthCallback, whoAmI, listEventsToday, createEvent } from "./gcal.js";
import { URL } from "url";

function parseToolArgs(maybeJSON) {
  try { return typeof maybeJSON === "string" ? JSON.parse(maybeJSON) : maybeJSON; }
  catch { return {}; }
}

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
const server = http.createServer(async (req, res) => {
  try {
    const fullUrl = new URL(req.url, BASE_URL);
    const path = fullUrl.pathname;

    if (path === "/voice") {
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

    if (path === "/auth/google") {
      const url = getAuthUrl();
      res.writeHead(302, { Location: url });
      return res.end();
    }

    if (path === "/oauth2callback") {
      const code = fullUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Missing ?code");
      }
      await handleOAuthCallback(code);
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<h3>Google connected ✅</h3><p>You can close this tab.</p>`);
    }

    if (path === "/gcal/me") {
      const info = await whoAmI();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(info, null, 2));
    }

    if (path === "/gcal/today") {
      const items = await listEventsToday();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(items, null, 2));
    }

    if (path === "/gcal/create") {
      const summary = fullUrl.searchParams.get("summary") || "Untitled";
      const start = fullUrl.searchParams.get("start");
      const end = fullUrl.searchParams.get("end");
      const attendees = (fullUrl.searchParams.get("attendees") || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      if (!start || !end) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Provide start and end ISO strings");
      }

      console.log("[HTTP] /gcal/create",
        "summary=", summary, "start=", start, "end=", end, "attendees=", attendees.join(",")
      );
      
      const event = await createEvent({ summary, start, end, attendees });
      
      console.log("[HTTP] /gcal/create OK id=", event.id);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(event, null, 2));
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Barber AI Realtime bridge is alive.\n");
  } catch (err) {
    console.error("[HTTP error]", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
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
  u = ~u & 0xff;
  const sign = u & 0x80;
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= 0x84;
  return sign ? -sample : sample;
}

function rmsOfMuLawBase64(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    const len = buf.length;
    if (!len) return 0;
    let sumSq = 0;
    const stride = len > 3200 ? Math.floor(len / 1600) : 1;
    let count = 0;
    for (let i = 0; i < len; i += stride) {
      const s = muLawByteToPcm16(buf[i]);
      sumSq += s * s;
      count++;
    }
    const meanSq = sumSq / Math.max(1, count);
    return Math.sqrt(meanSq) / 32768;
  } catch {
    return 0;
  }
}

// ---------- Conversation policies (tunable) ----------
const VAD = {
  FRAME_MS: 20,
  RMS_START: 0.02,
  RMS_CONTINUE: 0.015,
  MIN_SPEECH_MS: 80,
  END_SILENCE_MS: 1000,
  BARGE_IN_MIN_MS: 75,
  MAX_TURN_DURATION_MS: 6000,
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
  let awaitingResponse = false;
  let userSpeechActive = false;
  let userSpeechMs = 0;
  let silenceMs = 0;
  let turnMs = 0;

  let collectedBytes = 0;
  let capturedFrames = [];
  let queuedFrames = [];
  let queuedBytes = 0;

  function resetUserCapture() {
    userSpeechActive = false;
    userSpeechMs = 0;
    silenceMs = 0;
    turnMs = 0;
    collectedBytes = 0;
    capturedFrames = [];
  }

  function appendUserAudio(b64) {
    const level = rmsOfMuLawBase64(b64);

    if (!userSpeechActive) {
      if (level >= VAD.RMS_START) {
        userSpeechActive = true;
        userSpeechMs = VAD.FRAME_MS;
        silenceMs = 0;
      } else {
        return;
      }
    } else {
      if (level >= VAD.RMS_CONTINUE) {
        userSpeechMs += VAD.FRAME_MS;
        silenceMs = 0;
      } else {
        silenceMs += VAD.FRAME_MS;
      }
    }

    capturedFrames.push(b64);
    collectedBytes += Buffer.from(b64, "base64").length;
    turnMs += VAD.FRAME_MS;

    if (isAssistantSpeaking && userSpeechMs >= VAD.BARGE_IN_MIN_MS && !awaitingResponse) {
      console.log("[BARGE-IN] Canceling assistant due to user speech");
      safeSendOpenAI({ type: "response.cancel" });
      isAssistantSpeaking = false;
    }

    const utteranceLongEnough = userSpeechMs >= VAD.MIN_SPEECH_MS;
    const endedBySilence = silenceMs >= VAD.END_SILENCE_MS;
    const endedByTimeout = turnMs >= VAD.MAX_TURN_DURATION_MS;

    if ((utteranceLongEnough && endedBySilence) || endedByTimeout) {
      if (capturedFrames.length < 5) {
        resetUserCapture();
        return;
      }

      if (awaitingResponse) {
        queuedFrames = capturedFrames.slice();
        queuedBytes = collectedBytes;
        resetUserCapture();
        return;
      }

      for (const f of capturedFrames) {
        safeSendOpenAI({ type: "input_audio_buffer.append", audio: f });
      }
      safeSendOpenAI({ type: "input_audio_buffer.commit" });

      awaitingResponse = true;
      console.log(`[TURN] committing: ${capturedFrames.length} frames, ${collectedBytes} bytes`);
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "auto",
          instructions:
            "If the caller requested a booking and details are complete, call book_appointment; " +
            "otherwise ask concise follow-ups. Keep it brief and in American English.",
        },
      });
      resetUserCapture();
    }
  }

  async function handleBookAppointment(args) {
    const {
      customer_name,
      phone,
      service,
      start_iso,
      duration_min = 30,
      notes = "",
      attendees = [],
    } = args || {};

    if (!customer_name || !service || !start_iso || !duration_min) {
      return { ok: false, error: "Missing required fields." };
    }

    const start = new Date(start_iso);
    if (isNaN(start.getTime())) {
      return { ok: false, error: "Invalid start time." };
    }
    const end = new Date(start.getTime() + duration_min * 60 * 1000);

    const summary = `${service} — ${customer_name}`;
    const description =
      `Booked by phone receptionist.\n` +
      (phone ? `Phone: ${phone}\n` : "") +
      (notes ? `Notes: ${notes}\n` : "");

    try {
      const ev = await createEvent({
        summary,
        start: start.toISOString(),
        end: end.toISOString(),
        attendees,
        description,
      });
      return {
        ok: true,
        id: ev.id,
        htmlLink: ev.htmlLink,
        start: ev.start?.dateTime,
        end: ev.end?.dateTime,
        summary: ev.summary,
      };
    } catch (e) {
      return { ok: false, error: e?.message || "Calendar error" };
    }
  }

  // ---------- OpenAI socket ----------
  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");
    safeSendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw",
        input_audio_format: "g711_ulaw",
        tools: [
          {
            type: "function",
            name: "book_appointment",
            description:
              "Create a Google Calendar event for a haircut/barber service. Ask for any missing details before calling this.",
            parameters: {
              type: "object",
              properties: {
                customer_name: { type: "string", description: "Caller’s name" },
                phone: { type: "string", description: "Caller phone, if known" },
                service: { type: "string", description: "Service name" },
                start_iso: {
                  type: "string",
                  description:
                    "Start time in ISO 8601 with timezone (e.g. 2025-09-10T15:00:00-04:00)",
                },
                duration_min: {
                  type: "number",
                  description: "Duration in minutes (e.g. 30)",
                  default: 30,
                },
                notes: { type: "string", description: "Optional extra notes" },
                attendees: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional attendee emails",
                },
              },
              required: ["customer_name", "service", "start_iso", "duration_min"],
            },
          },
        ],
        tool_choice: "auto",
        instructions: INSTRUCTIONS,
      },
    });

    while (openaiOutbox.length) openaiWS.send(openaiOutbox.shift());
  });

  openaiWS.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error("[OpenAI] parse error");
      return;
    }

    if (!["response.output_audio.delta", "response.audio.delta"].includes(msg.type)) {
      console.log("[OpenAI EVENT]", msg.type);
    }

    if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
      isAssistantSpeaking = true;
      const payload = msg.audio || msg.delta;
      safeSendTwilio({ event: "media", media: { payload } });
      return;
    }
    if (msg.type === "response.audio.done") {
      isAssistantSpeaking = false;
      return;
    }
    if (msg.type === "response.done") {
      isAssistantSpeaking = false;
      awaitingResponse = false;

      if (queuedFrames.length) {
        for (const f of queuedFrames) {
          safeSendOpenAI({ type: "input_audio_buffer.append", audio: f });
        }
        safeSendOpenAI({ type: "input_audio_buffer.commit" });
        console.log(`[TURN] committed queued utterance: ${queuedFrames.length} frames, ${queuedBytes} bytes`);
        queuedFrames = [];
        queuedBytes = 0;

        awaitingResponse = true;
        safeSendOpenAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            conversation: "auto",
            instructions:
              "If the caller requested a booking and details are complete, call book_appointment; otherwise ask concise follow-ups. Keep it brief and in American English.",
          },
        });
        return;
      }

      if (!userSpeechActive) {
        safeSendOpenAI({ type: "input_audio_buffer.clear" });
      }
      return;
    }
    if (msg.type === "error") {
      console.error("[OpenAI ERROR]", msg);
      return;
    }

    // --- tool call handling kept same as your version ---
    openaiWS._toolCalls = openaiWS._toolCalls || {};
    if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
      const call = msg.item;
      const id = call.id;
      const name = call.name;
      openaiWS._toolCalls[id] = openaiWS._toolCalls[id] || { name, argsText: "" };
      if (typeof call.arguments === "string") openaiWS._toolCalls[id].argsText += call.arguments;
      return;
    }
    if (msg.type === "response.tool_call.created" || msg.type === "response.tool_call.delta") {
      const call = msg.tool_call || {};
      const id = call.id || msg.call_id;
      if (!id) return;
      const name = call.name;
      openaiWS._toolCalls[id] = openaiWS._toolCalls[id] || { name, argsText: "" };
      if (typeof call.arguments === "string") openaiWS._toolCalls[id].argsText += call.arguments;
      return;
    }
    if (msg.type === "response.tool_call.completed") {
      const id = msg.tool_call?.id || msg.call_id;
      const entry = id ? openaiWS._toolCalls[id] : null;
      if (!entry) return;
      const args = parseToolArgs(entry.argsText || "{}");
      if (entry.name === "book_appointment") {
        const result = await handleBookAppointment(args);
        safeSendOpenAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            conversation: "auto",
            instructions: "Acknowledge the booking result clearly. If it failed, say why and suggest another time.",
            tool_results: [{ tool_call_id: id, output: JSON.stringify(result) }],
          },
        });
      }
      return;
    }
    if (msg.type === "response.function_call_arguments.delta") {
      const id = msg.call_id || msg.item_id || msg.id;
      const name = msg.name;
      if (!id) return;
      openaiWS._toolCalls[id] = openaiWS._toolCalls[id] || { name, argsText: "" };
      if (typeof msg.delta === "string") openaiWS._toolCalls[id].argsText += msg.delta;
      return;
    }
    if (msg.type === "response.function_call_arguments.done") {
      const id = msg.call_id || msg.item_id || msg.id;
      const entry = id ? openaiWS._toolCalls[id] : null;
      if (!entry) return;
      const args = parseToolArgs(entry.argsText || "{}");
      if (entry.name === "book_appointment") {
        const result = await handleBookAppointment(args);
        safeSendOpenAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            conversation: "auto",
            instructions: "Acknowledge the booking result clearly. If it failed, say why and suggest another time.",
            tool_results: [{ tool_call_id: id, output: JSON.stringify(result) }],
          },
        });
      }
      return;
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

      // Deterministic greeting from AI
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "none",
          instructions: "Say exactly: 'Hello, thank you for calling the barbershop! How can I help you today.'"
        },
      });
      awaitingResponse = true;
      return;
    }

    // 🔙 RESTORED: feed caller audio to VAD so the bot can hear
    if (msg.event === "media") {
      const b64 = msg.media?.payload;
      if (!b64) return;
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
