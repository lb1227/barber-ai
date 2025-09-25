// server.js
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { getAuthUrl, handleOAuthCallback, whoAmI, listEventsToday, createEvent, listEventsOn } from "./gcal.js";
import { URL } from "url";

const ALLOW_ORIGIN = process.env.GUI_ORIGIN || "*"; // e.g. https://<user>.github.io

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
    // CORS for all routes
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Parse URL & query safely (BASE_URL already defined in your file)
    const fullUrl = new URL(req.url, BASE_URL);
    const path = fullUrl.pathname;

    // === Twilio voice ===
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

    if (path === "/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ baseUrl: BASE_URL }, null, 2));
    }

    // === Google OAuth kick-off ===
    if (path === "/auth/google") {
      const url = getAuthUrl();
      res.writeHead(302, { Location: url });
      return res.end();
    }

    // === Google OAuth callback ===
    if (path === "/gcal/oauth2callback") {
      const code = fullUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Missing ?code");
      }
      await handleOAuthCallback(code);
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<h3>Google connected ✅</h3><p>You can close this tab.</p>`);
    }

    // === Quick sanity checks ===
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

    // === (Optional) quick-create test endpoint ===
    // /gcal/create?summary=Test&start=2025-09-10T15:00:00-04:00&end=2025-09-10T15:30:00-04:00
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

    // === Default health check ===
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
  // μ-law decode (G.711) – returns int16
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
  FRAME_MS: 20,          // Twilio sends ~20ms frames
  RMS_START: 0.055,
  RMS_CONTINUE: 0.040,
  MIN_SPEECH_MS: 260,    // was 320 (slightly quicker)
  END_SILENCE_MS: 900,   // was 1200 (commit sooner)
  BARGE_IN_MIN_MS: 120,  // was 150 (caller can interrupt a bit faster)
  MAX_TURN_DURATION_MS: 6000,
};
const MIN_AVG_RMS = 0.030; // reject very quiet "turns"

// === NEW: enforce exact greeting + brief pause before listening ===
const EXPECTED_GREETING = "thank you for calling mobile pet grooming, how can i help you today?";
const POST_GREETING_COOLDOWN_MS = 700; // ~0.7s pause after greeting

// === Identity, task & style ===
const INSTRUCTIONS =
  [
    "You are a **Mobile Pet Grooming Assistant** for a small business.",
    "Your primary tasks: **book, reschedule, and cancel appointments**, and **answer basic questions** about services, pricing ranges, service areas, hours, and simple policies.",
    "Scope guard: **only** discuss topics related to mobile pet grooming. If asked something unrelated, politely steer back to grooming and booking.",
    "",
    "# Style",
    "- Tone: **warm, conversational, and slightly upbeat**.",
    "- Enthusiasm: **calm and positive**—welcoming, not flat.",
    "- Formality: **casual but slightly professional**.",
    "- Emotion: **appropriately expressive**; empathetic and polite.",
    "- Pacing: **slightly brisk**. Keep replies short (≈8–14 words).",
    "",
    "# Single-question policy (STRICT)",
    "- Ask for **exactly one** piece of information per turn.",
    "- The **only allowed pair** is: **“What day and time work best for your appointment?”**",
    "- Never combine other fields in one sentence (e.g., **no** “name and phone”, **no** “service and date”).",
    "- Collect in this order: **name → service → phone → date & time**.",
    "- After each answer, acknowledge briefly and ask the next single question.",
    "- End your turn immediately after asking the question. Do not add a second clause.",
  ].join("\n");

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
        "x-openai-audio-input-format":  "g711_ulaw;rate=8000", // 👈 REQUIRED
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
  let awaitingResponse = false; // a response.create is in flight (e.g., greeting)
  let userSpeechActive = false;
  let userSpeechMs = 0;
  let silenceMs = 0;
  let turnMs = 0;
  let bargeMs = 0;

  let collectedBytes = 0;
  let capturedFrames = [];
  let sumLevel = 0;
  let levelCount = 0;

  // Greeting lock & cooldown
  let greetingInFlight = false;
  let greetTranscript = "";
  let postGreetingUntilTs = 0;

  // Guards for “one question per turn”
  let assistantUtterance = "";         // live transcript during assistant speech
  let sawQuestionStart = false;        // detected the start of a question
  let singleQuestionCutApplied = false;// already cut this turn after the first question

  function resetUserCapture() {
    userSpeechActive = false;
    userSpeechMs = 0;
    silenceMs = 0;
    turnMs = 0;
    bargeMs = 0;
    collectedBytes = 0;
    capturedFrames = [];
    sumLevel = 0;
    levelCount = 0;
  }

  // === Double-question detector (allow only “date and time”) ===
  function isDisallowedDoubleQuestion(text) {
    const s = (text || "").toLowerCase();

    const nameTokens    = ["name", "first name", "last name"];
    const serviceTokens = ["service", "groom", "grooming", "bath", "nail", "trim"];
    const phoneTokens   = ["phone", "phone number", "callback", "contact number"];
    const dateTokens    = ["date", "day", "today", "tomorrow", "monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
    const timeTokens    = ["time", "am", "pm", "morning", "afternoon", "evening"];

    const hasAny = (tokens) => tokens.some(t => s.includes(t));
    const cats = new Set();
    if (hasAny(nameTokens))    cats.add("name");
    if (hasAny(serviceTokens)) cats.add("service");
    if (hasAny(phoneTokens))   cats.add("phone");
    if (hasAny(dateTokens))    cats.add("date");
    if (hasAny(timeTokens))    cats.add("time");

    // Only allowed pair is exactly date + time
    if (cats.size === 2 && cats.has("date") && cats.has("time")) return false;

    return cats.size >= 2;
  }

  function reAskSingleQuestion() {
    if (isAssistantSpeaking || awaitingResponse) safeSendOpenAI({ type: "response.cancel" });
    awaitingResponse = true;
    safeSendOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        conversation: "auto",
        instructions:
          "Ask **only one** concise question for the next missing field (order: name → service → phone → date & time). " +
          "Do not combine fields. The only allowed pair is: “What day and time work best for your appointment?”",
      },
    });
  }

  function appendUserAudio(b64) {
    // Do NOT listen while greeting is speaking or during short cooldown after it
    if (greetingInFlight || Date.now() < postGreetingUntilTs) return;

    const level = rmsOfMuLawBase64(b64);

    if (isAssistantSpeaking || awaitingResponse) {
      if (level >= VAD.RMS_START) {
        bargeMs += VAD.FRAME_MS;
        if (bargeMs >= VAD.BARGE_IN_MIN_MS) {
          if (isAssistantSpeaking || awaitingResponse) {
            safeSendOpenAI({ type: "response.cancel" });
          }
          isAssistantSpeaking = false;
          awaitingResponse = false;
          resetUserCapture();
        }
      } else {
        bargeMs = 0;
      }
      return;
    }

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
    sumLevel += level;
    levelCount += 1;

    const utteranceLongEnough = userSpeechMs >= VAD.MIN_SPEECH_MS;
    const endedBySilence = silenceMs >= VAD.END_SILENCE_MS;
    const endedByTimeout = turnMs >= VAD.MAX_TURN_DURATION_MS;

    if ((utteranceLongEnough && endedBySilence) || endedByTimeout) {
      if (capturedFrames.length < 5) {
        resetUserCapture();
        return;
      }

      const avgLevel = levelCount ? (sumLevel / levelCount) : 0;
      if (avgLevel < MIN_AVG_RMS) {
        resetUserCapture();
        return;
      }
      
      for (const f of capturedFrames) {
        safeSendOpenAI({ type: "input_audio_buffer.append", audio: f });
      }
      safeSendOpenAI({ type: "input_audio_buffer.commit" });

      // reset per-turn guards
      assistantUtterance = "";
      sawQuestionStart = false;
      singleQuestionCutApplied = false;

      awaitingResponse = true;
      console.log(`[TURN] committing: ${capturedFrames.length} frames, ${collectedBytes} bytes`);
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "auto",
          instructions:
            "Stay warm and brief. Ask **only one** concise question next. " +
            "If the caller provided name, service, start time, and phone, call `book_appointment`. " +
            "If they ask about availability, call `list_appointments`. " +
            "For rescheduling/canceling, confirm name and the date/time to change, then proceed. " +
            "Only discuss mobile pet grooming topics.",
        },
      });
      resetUserCapture();
    }
  }

  async function handleListAppointments(args) {
    const { day, date_iso } = args || {};
    let target = date_iso ? new Date(date_iso) : new Date();
  
    if (!date_iso && day === "tomorrow") {
      target.setDate(target.getDate() + 1);
    }
    // today/default handled implicitly
  
    try {
      const items = await listEventsOn(target.toISOString());
      return {
        ok: true,
        count: items.length,
        events: items.map(e => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end:   e.end?.dateTime   || e.end?.date,
          attendees: (e.attendees || []).map(a => a.email),
          htmlLink: e.htmlLink
        }))
      };
    } catch (e) {
      return { ok: false, error: e?.message || "Calendar read error" };
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

    const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/;

    if (!customer_name || !service || !start_iso || !phone) {
      return { ok: false, error: "Missing required fields." };
    }
    if (!PHONE_RE.test(String(phone))) {
      return { ok: false, error: "Invalid phone number." };
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
    console.log("[OpenAI] WS open]");
    // Configure to be reactive; our VAD drives turns.
    safeSendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "verse", // consistent female voice
        output_audio_format: "g711_ulaw",
        input_audio_format: "g711_ulaw",

        tools: [
          {
            type: "function",
            name: "book_appointment",
            description:
              "Create a Google Calendar event for a mobile pet grooming service. Ask for any missing details before calling this.",
            parameters: {
              type: "object",
              properties: {
                customer_name: { type: "string", description: "Caller’s name" },
                phone: { type: "string", description: "Caller phone, if known" },
                service: { type: "string", description: "Service name" },
                start_iso: {
                  type: "string",
                  description: "Start time in ISO 8601 with timezone (e.g. 2025-09-10T15:00:00-04:00)"
                },
                duration_min: { type: "number", description: "Duration in minutes (e.g. 30)", default: 30 },
                notes: { type: "string", description: "Optional extra notes (pet breed/size, address/ZIP, etc.)" },
                attendees: { type: "array", items: { type: "string" }, description: "Optional attendee emails" }
              },
              required: ["customer_name", "service", "start_iso", "phone"],
            },
          },
          {
            type: "function",
            name: "list_appointments",
            description: "List Google Calendar events for a specific day (today, tomorrow, or date_iso).",
            parameters: {
              type: "object",
              properties: {
                day: { type: "string", enum: ["today", "tomorrow"], description: "Shortcut day selector" },
                date_iso: { type: "string", description: "Any date in ISO 8601; time ignored (e.g. 2025-09-18)" }
              }
            }
          }
        ],
        tool_choice: "auto",

        instructions: INSTRUCTIONS,
      },
    });

    while (openaiOutbox.length) openaiWS.send(openaiOutbox.shift());
  });

  openaiWS.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { console.error("[OpenAI] parse error"); return; }

    openaiWS._toolCalls   = openaiWS._toolCalls   || {};
    openaiWS._toolIdAlias = openaiWS._toolIdAlias || {};
    function setAlias(itemId, callId) { if (!itemId || !callId) return; openaiWS._toolIdAlias[itemId] = callId; openaiWS._toolIdAlias[callId] = itemId; }
    function getEntryByAnyId({ call_id, item_id, id }) { const ids=[call_id,item_id,id].filter(Boolean); for (const k of ids){ if (openaiWS._toolCalls[k]) return {key:k,entry:openaiWS._toolCalls[k]}; const a=openaiWS._toolIdAlias[k]; if (a && openaiWS._toolCalls[a]) return {key:a,entry:openaiWS._toolCalls[a]}; } return null; }
    function ensureEntry(key, name) { if (!key) return null; openaiWS._toolCalls[key] = openaiWS._toolCalls[key] || { name, argsText: "" }; if (name && !openaiWS._toolCalls[key].name) openaiWS._toolCalls[key].name = name; return openaiWS._toolCalls[key]; }

    const NOISY_TYPES = new Set(["response.audio_transcript.delta","response.output_audio.delta","response.audio.delta"]);
    if (!NOISY_TYPES.has(msg.type)) console.log("[OpenAI EVENT]", msg.type);

    // ====== AUDIO STREAMING ======
    if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
      isAssistantSpeaking = true;
      const payload = msg.audio || msg.delta;
      sendMulawToTwilio(payload);
      return;
    }
    if (msg.type === "response.audio.done") {
      isAssistantSpeaking = false;
      // reset any partial line we were analyzing
      assistantUtterance = "";
      sawQuestionStart = false;
      return;
    }

    // ====== LIVE TEXT GUARDS ======
    // 1) Greeting enforcement while greeting is being spoken
    if (msg.type === "response.audio_transcript.delta" && greetingInFlight) {
      const piece = msg.delta || "";
      if (piece) {
        greetTranscript += piece.toLowerCase();

        const drifted =
          greetTranscript.includes("name") ||
          greetTranscript.includes("service") ||
          greetTranscript.includes("phone") ||
          greetTranscript.length > EXPECTED_GREETING.length + 5;

        if (drifted) {
          safeSendOpenAI({ type: "response.cancel" });
          safeSendOpenAI({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              conversation: "auto",
              instructions:
                "Say exactly: 'Thank you for calling Mobile Pet Grooming, How can I help you today?'"
            },
          });
          greetTranscript = "";
          awaitingResponse = true;
        }
      }
      return;
    }

    // 2) After greeting, block double-questions and enforce single-question cutoff (no replay)
    if (
      (msg.type === "response.audio_transcript.delta" || msg.type === "response.output_text.delta") &&
      !greetingInFlight
    ) {
      const piece = msg.delta || msg.text || msg.output_text || "";
      if (piece) {
        assistantUtterance += piece;
        const lower = assistantUtterance.toLowerCase();

        // A) If it starts combining multiple fields (except date+time), stop immediately (no replay)
        if (isDisallowedDoubleQuestion(assistantUtterance)) {
          console.log("[Guard] multi-field question detected → cancel, no replay");
          safeSendOpenAI({ type: "response.cancel" });
          awaitingResponse = false;           // let VAD capture the caller next
          assistantUtterance = "";            // reset guard buffer
          sawQuestionStart = false;
          singleQuestionCutApplied = true;
          return;
        }

        // B) Early catch: once a question has started, if we see a connector that typically
        // begins a second question (“, and…”, “, also…”, “, what…”, etc.), stop immediately.
        const questionStartRegex = /\b(what|when|which|could you|can you|can i|may i|would you|do you|what's|what is|please|share|tell me|get your|could i)\b/;
        if (!sawQuestionStart && questionStartRegex.test(lower)) {
          sawQuestionStart = true;
        }
        const looksLikeSecondStart =
          sawQuestionStart &&
          /(?:,?\s+and\s+|,?\s+(?:also|as well)\s+|,?\s+(?:what|when|which|can you|could you|may i|would you)\b)/.test(lower);

        if (looksLikeSecondStart) {
          console.log("[Guard] early second-question connector → cancel, no replay");
          safeSendOpenAI({ type: "response.cancel" });
          awaitingResponse = false;
          assistantUtterance = "";
          sawQuestionStart = false;
          singleQuestionCutApplied = true;
          return;
        }

        // C) Clean cutoff at the first question mark — stop right after the first question
        if (lower.includes("?")) {
          console.log("[Guard] first question ended (‘?’) → stop this turn");
          singleQuestionCutApplied = true;
          safeSendOpenAI({ type: "response.cancel" });
          awaitingResponse = false;
          assistantUtterance = "";
          sawQuestionStart = false;
          return;
        }

        // D) If the model never uses '?', infer a cutoff after sentence end or if it runs long
        if (sawQuestionStart && (lower.includes(". ") || lower.includes("! ") || assistantUtterance.length > 120)) {
          console.log("[Guard] inferred end of first question → cancel, no replay");
          safeSendOpenAI({ type: "response.cancel" });
          awaitingResponse = false;
          assistantUtterance = "";
          sawQuestionStart = false;
          singleQuestionCutApplied = true;
          return;
        }
      }
      return;
    }

    if (msg.type === "response.done") {
      isAssistantSpeaking = false;
      awaitingResponse = false;

      if (greetingInFlight) {
        greetingInFlight = false;
        postGreetingUntilTs = Date.now() + POST_GREETING_COOLDOWN_MS;
        greetTranscript = "";
      }

      // reset guards at end of assistant turn
      assistantUtterance = "";
      sawQuestionStart = false;
      singleQuestionCutApplied = false;

      if (!userSpeechActive) safeSendOpenAI({ type: "input_audio_buffer.clear" });
      return;
    }
    if (msg.type === "error") {
      console.error("[OpenAI ERROR]", msg);
      isAssistantSpeaking = false;
      awaitingResponse = false;
      assistantUtterance = "";
      sawQuestionStart = false;
      singleQuestionCutApplied = false;
      return;
    }

    function isBookingArgs(args) { return !!(args && args.customer_name && args.service && args.start_iso && args.phone); }
    function isListArgs(args) { return !!(args && (args.day || args.date_iso)); }

    async function finishToolCall(callId) {
      const entry = openaiWS._toolCalls[callId];
      if (!callId || !entry) return;

      const args = parseToolArgs(entry.argsText || "{}");
      const rawName = (entry.name || "").toLowerCase();
      const effectiveName =
        rawName || (isBookingArgs(args) ? "book_appointment" : isListArgs(args) ? "list_appointments" : "");

      console.log("[TOOL NAME]", effectiveName || "(missing)", "args=", args);

      if (effectiveName === "book_appointment") {
        const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/;
        if (!args?.phone || !PHONE_RE.test(String(args.phone))) {
          if (isAssistantSpeaking || awaitingResponse) safeSendOpenAI({ type: "response.cancel" });
          awaitingResponse = true;
          safeSendOpenAI({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              conversation: "auto",
              instructions:
                "Warm and brief: ask only one question — “What’s the best phone number to reach you?” Then wait silently."
            }
          });
          return;
        }
      }

      let result = { ok: false, error: "Unknown tool" };
      if (effectiveName === "book_appointment") {
        result = await handleBookAppointment(args);
      } else if (effectiveName === "list_appointments") {
        result = await handleListAppointments(args);
      } else {
        console.log("[TOOL ROUTING] Unknown tool name:", rawName, "args=", args);
      }

      safeSendOpenAI({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
      });

      if (isAssistantSpeaking || awaitingResponse) safeSendOpenAI({ type: "response.cancel" });
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "auto",
          instructions:
            effectiveName === "book_appointment"
              ? "Confirm the booking in one short sentence. If it failed, briefly explain and offer the next two options."
              : "Summarize that day’s schedule in one short, friendly sentence. If none or error, say so briefly.",
        },
      });

      delete openaiWS._toolCalls[callId];
    }

    if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
      const { id: itemId, name, arguments: chunk } = msg.item;
      console.log("[TOOL START]", name, "call_id=", itemId);
      const entry = ensureEntry(itemId, name);
      if (entry && typeof chunk === "string") entry.argsText += chunk;
      return;
    }
    if (msg.type === "response.tool_call.created") {
      const { id, name, arguments: chunk } = msg.tool_call || {};
      const entry = ensureEntry(id, name);
      if (entry && typeof chunk === "string") entry.argsText += chunk;
      return;
    }
    if (msg.type === "response.function_call_arguments.delta") {
      const { call_id, item_id, name, delta } = msg;
      if (call_id && item_id) { openaiWS._toolIdAlias[item_id] = call_id; openaiWS._toolIdAlias[call_id] = item_id; }
      let hit = getEntryByAnyId({ call_id, item_id, id: msg.id });
      if (!hit && item_id) hit = { key: item_id, entry: ensureEntry(item_id, name) };
      if (!hit && call_id) hit = { key: call_id, entry: ensureEntry(call_id, name) };
      if (hit?.entry && typeof delta === "string") hit.entry.argsText += delta;
      return;
    }
    if (msg.type === "response.tool_call.delta") {
      const { id, name, arguments: chunk } = msg.tool_call || {};
      const entry = ensureEntry(id, name);
      if (entry && typeof chunk === "string") entry.argsText += chunk;
      return;
    }
    if (msg.type === "response.function_call_arguments.done") {
      const { call_id, item_id, name } = msg;
      if (call_id && item_id) { openaiWS._toolIdAlias[item_id] = call_id; openaiWS._toolIdAlias[call_id] = item_id; }
      let hit = getEntryByAnyId({ call_id, item_id, id: msg.id });
      if (!hit && item_id) hit = { key: item_id, entry: ensureEntry(item_id, name) };
      if (!hit && call_id) hit = { key: call_id, entry: ensureEntry(call_id, name) };
      const effectiveId = call_id || item_id || hit?.key;
      console.log("[TOOL ARGS DONE] call_id=", effectiveId, "args=", hit?.entry?.argsText);
      await finishToolCall(effectiveId);
      return;
    }
    if (msg.type === "response.tool_call.completed") {
      const id = msg.tool_call?.id || msg.call_id;
      await finishToolCall(id);
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

      // Greeting (AI speaks)
      greetingInFlight = true;
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "auto",
          instructions:
            "Say exactly: 'Thank you for calling Mobile Pet Grooming, How can I help you today?'"
        },
      });
      awaitingResponse = true;
      return;
    }

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

  function sendMulawToTwilio(b64) {
    if (!twilioReady || !streamSid) return;
    const raw = Buffer.from(b64, "base64");
    const FRAME = 160; // 20ms @ 8kHz μ-law

    for (let i = 0; i < raw.length; i += FRAME) {
      const slice = raw.subarray(i, Math.min(i + FRAME, raw.length));
      safeSendTwilio({
        event: "media",
        streamSid,
        media: { payload: slice.toString("base64") }
      });
    }
  }

  // ---------- Closures & errors ----------
  twilioWS.on("close", () => { console.log("[Twilio] closed"); safeClose(openaiWS); });
  openaiWS.on("close", () => { console.log("[OpenAI] closed"); safeClose(twilioWS); });
  twilioWS.on("error", (e) => console.error("[Twilio WS error]", e));
  openaiWS.on("error", (e) => console.error("[OpenAI WS error]", e));
});

server.listen(PORT, () => {
  console.log(`Minimal WS server ready at http://0.0.0.0:${PORT}`);
});

function safeClose(ws) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
}
