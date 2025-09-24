// server.js
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { getAuthUrl, handleOAuthCallback, whoAmI, listEventsToday, createEvent, listEventsOn } from "./gcal.js";
import { URL } from "url";

const ALLOW_ORIGIN = process.env.GUI_ORIGIN || "*"; // e.g. https://<user>.github.io

// inside createServer handler, right after you get req/res:
res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");
if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

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
// (unchanged)
process.on("uncaughtException", (err) => console.error("[Uncaught]", err));
process.on("unhandledRejection", (err) => console.error("[Unhandled]", err));

// ---------- HTTP server (TwiML + health) ----------
const server = http.createServer(async (req, res) => {
  try {
    // Parse URL & query safely (BASE_URL already defined in your file)
    const fullUrl = new URL(req.url, BASE_URL);
    const path = fullUrl.pathname;

    // === Twilio voice ===
    if (path === "/voice") {
      const twiml = `
        <Response>
          <Connect>
            <Stream url="${BASE_URL.replace(/^https?/, "wss")}/media" track="both_tracks"/>
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
    res.end("Mobile Pet Grooming AI Realtime bridge is alive.\n");
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
// (unchanged)
function muLawByteToPcm16(u) { /* ... */ }
function rmsOfMuLawBase64(b64) { /* ... */ }

// ---------- Conversation policies (tunable) ----------
// (unchanged thresholds)
const VAD = {
  FRAME_MS: 20,
  RMS_START: 0.055,
  RMS_CONTINUE: 0.040,
  MIN_SPEECH_MS: 320,
  END_SILENCE_MS: 1200,
  BARGE_IN_MIN_MS: 150,
  MAX_TURN_DURATION_MS: 6000,
};
const MIN_AVG_RMS = 0.030;

// === UPDATED: instructions for mobile pet grooming (booking-only, no transfers)
const INSTRUCTIONS =
  "You are a mobile pet grooming phone receptionist. STRICT RULES:\n" +
  "1) Respond ONLY in clear American English.\n" +
  "2) If the caller is not speaking English, say exactly once: 'Sorry—I only speak English.' Then remain silent until you detect English.\n" +
  "3) Do NOT reply to background noise, music, tones, or non-speech. Stay silent unless you detect human speech in English.\n" +
  "4) Be concise and professional. Stop speaking immediately if interrupted.\n" +
  "5) Never start a conversation on your own. Only respond after the caller has spoken English.\n" +
  "6) Your goal is to BOOK APPOINTMENTS (no live transfers). Collect name, phone, service, preferred time/day; pet species & breed/size can be added to notes.\n" +
  "7) After asking a question, wait silently.\n";

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
        "x-openai-audio-input-format":  "g711_ulaw;rate=8000",
      },
    }
  );

  // Send helpers (unchanged)
  const safeSendTwilio = (msgObj) => { /* ... */ };
  const openaiOutbox = [];
  const safeSendOpenAI = (obj) => { /* ... */ };

  // ---- Turn & VAD state machine ----
  // (unchanged state vars & helpers)
  let isAssistantSpeaking = false;
  let awaitingResponse = false;
  let userSpeechActive = false;
  let userSpeechMs = 0;
  let silenceMs = 0;
  let turnMs = 0;
  let bargeMs = 0;

  let collectedBytes = 0;
  let capturedFrames = [];
  let sumLevel = 0;
  let levelCount = 0;
  let greetingInFlight = false;

  function resetUserCapture() { /* ... */ }
  function appendUserAudio(b64) { /* ... existing logic ... */ }

  async function handleListAppointments(args) { /* ... */ }

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
    console.log("[OpenAI] WS open");
    // Configure to be *reactive only*; we do our own VAD and turn-taking.
    safeSendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw",
        input_audio_format: "g711_ulaw",

        // UPDATED: tool descriptions swapped to grooming context
        tools: [
          {
            type: "function",
            name: "book_appointment",
            description:
              "Create a Google Calendar event for a mobile pet grooming service. " +
              "Ask for any missing details before calling this.",
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
                notes: { type: "string", description: "Optional extra notes (pet breed/size, address/ZIP, etc.)" },
                attendees: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional attendee emails",
                },
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

        // No server VAD; we control turns. Also behavior rules:
        instructions: INSTRUCTIONS,
      },
    });

    // flush queued messages if any
    while (openaiOutbox.length) openaiWS.send(openaiOutbox.shift());
  });

  openaiWS.on("message", async (data) => {
    // (unchanged except wording in comments)
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error("[OpenAI] parse error");
      return;
    }

    openaiWS._toolCalls   = openaiWS._toolCalls   || {};
    openaiWS._toolIdAlias = openaiWS._toolIdAlias || {};

    function setAlias(itemId, callId) { /* ... */ }
    function getEntryByAnyId({ call_id, item_id, id }) { /* ... */ }
    function ensureEntry(key, name) { /* ... */ }

    const NOISY_TYPES = new Set([
      "response.audio_transcript.delta",
      "response.output_audio.delta",
      "response.audio.delta",
    ]);
    if (!NOISY_TYPES.has(msg.type)) {
      console.log("[OpenAI EVENT]", msg.type);
    }

    // ====== AUDIO STREAMING ======
    if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
      isAssistantSpeaking = true;
      const payload = msg.audio || msg.delta; // base64 μ-law
      sendMulawToTwilio(payload);
      return;
    }
    if (msg.type === "response.audio.done") {
      isAssistantSpeaking = false;
      return;
    }
    if (msg.type === "response.done") {
      isAssistantSpeaking = false;
      awaitingResponse = false;
      if (greetingInFlight) greetingInFlight = false;
      if (!userSpeechActive) {
        safeSendOpenAI({ type: "input_audio_buffer.clear" });
      }
      return;
    }
    if (msg.type === "error") {
      console.error("[OpenAI ERROR]", msg);
      isAssistantSpeaking = false;
      awaitingResponse = false;
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
        rawName ||
        (isBookingArgs(args) ? "book_appointment" : isListArgs(args) ? "list_appointments" : "");

      console.log("[TOOL NAME]", effectiveName || "(missing)", "args=", args);

      // GATE: require phone before booking; ask ONLY for phone if missing/invalid
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
                "Ask exactly one question only: 'What’s the best phone number to reach you?' " +
                "Do not ask anything else in the same turn. After asking, wait silently."
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

      // Return output to the model
      safeSendOpenAI({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        },
      });

      // Speak confirmation/answer
      if (isAssistantSpeaking || awaitingResponse) safeSendOpenAI({ type: "response.cancel" });
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "auto",
          instructions:
            effectiveName === "book_appointment"
              ? "Confirm the booking with time and service. If it failed, explain the reason and propose an alternative."
              : "Summarize the schedule for the requested day. If there are no events or an error, say so briefly.",
        },
      });

      delete openaiWS._toolCalls[callId];
    }

    // (rest of message handlers unchanged)
    if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") { /* ... */ return; }
    if (msg.type === "response.tool_call.created") { /* ... */ return; }
    if (msg.type === "response.function_call_arguments.delta") { /* ... */ return; }
    if (msg.type === "response.tool_call.delta") { /* ... */ return; }
    if (msg.type === "response.function_call_arguments.done") { /* ... */ return; }
    if (msg.type === "response.tool_call.completed") { /* ... */ return; }

    // ignore others
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

      // reset your VAD capture for a fresh call
      resetUserCapture();

      // UPDATED greeting (mobile pet grooming wording)
      greetingInFlight = true;
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          conversation: "auto",
          instructions: "Say exactly: 'Thanks for calling our mobile pet grooming. I can book you right now—how can I help?'"
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
