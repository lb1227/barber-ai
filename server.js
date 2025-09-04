// server.js
// Conversational phone assistant (OpenAI) + simple appointment API (SQLite)

import express from "express";
import "dotenv/config";
import db from "./database.js";

// -------------------- Basic app setup --------------------
const app = express();
// Twilio webhooks send application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Required: set in Render (Environment)
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY (set it in Render → Environment).");
  process.exit(1);
}

// -------------------- Config --------------------
const BUSINESS_NAME = "XYZ barbershop";
const BUSINESS_HOURS = "We’re open Tuesday through Saturday, 8 AM to 8 PM.";
const POLLY_VOICE = "Polly.Matthew-Neural"; // natural, human-like

// -------------------- Per-call session (in-memory) --------------------
/**
 * sessions: Map<CallSid, {
 *   intent?: 'book'|'reschedule'|'cancel'|'hours'|'greeting'|'goodbye'|'other',
 *   name?: string|null,
 *   phone?: string|null,
 *   time?: string|null,       // freeform time text (e.g., "tomorrow 3pm")
 *   apptId?: number|null
 * }>
 */
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) sessions.set(callSid, {});
  return sessions.get(callSid);
}
function clearSession(callSid) {
  sessions.delete(callSid);
}

// -------------------- Helpers --------------------
function normalizePhone(e164) {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  // US-centric: strip leading 1
  return digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
}

function xmlEscape(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sayGather({ prompt, action = "/voice/handle", hints = [] }) {
  // Twilio will listen to speech and POST to `action` with SpeechResult
  return `
    <Response>
      <Gather input="speech"
              action="${action}"
              method="POST"
              speechTimeout="auto"
              language="en-US"
              enhanced="true"
              bargeIn="true"
              hints="${xmlEscape(hints.join(","))}">
        <Say voice="${POLLY_VOICE}">
          ${xmlEscape(prompt)}
        </Say>
      </Gather>
      <Say voice="${POLLY_VOICE}">Sorry, I didn't catch that.</Say>
      <Redirect method="POST">/voice</Redirect>
    </Response>
  `.trim();
}

function sayThenHangup(text) {
  return `
    <Response>
      <Say voice="${POLLY_VOICE}">${xmlEscape(text)}</Say>
      <Hangup/>
    </Response>
  `.trim();
}

// -------------------- OpenAI intent extraction --------------------
async function extractIntentAndSlots(userUtterance, known = {}) {
  const system = `
You are a concise, friendly call receptionist for a barber shop.
Extract intent and fields from the caller's sentence.
Return ONLY strict JSON (no extra text), with this exact shape:

{
  "intent": "book" | "reschedule" | "cancel" | "hours" | "greeting" | "goodbye" | "other",
  "customer_name": string | null,
  "phone_number": string | null,
  "appointment_time": string | null,   // freeform OK, e.g., "tomorrow 3pm"
  "appointment_id": number | null
}

- If caller says hello/small talk, use "greeting".
- If caller asks open/close times, use "hours".
- If caller ends the call, use "goodbye".
- Fill any fields you can infer. If unsure, put null.
`.trim();

  const user = `
Caller said: "${userUtterance}"
Known so far: ${JSON.stringify(known)}
Return ONLY JSON. No prose.
`.trim();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    console.error("OpenAI error:", r.status, errText);
    return {
      intent: "other",
      customer_name: null,
      phone_number: null,
      appointment_time: null,
      appointment_id: null,
    };
  }

  const data = await r.json();
  try {
    const raw = data?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw);
  } catch {
    return {
      intent: "other",
      customer_name: null,
      phone_number: null,
      appointment_time: null,
      appointment_id: null,
    };
  }
}

// -------------------- VOICE: entry & loop --------------------

// 1) First response: greeting + listen
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || "no-sid";
  const session = getSession(callSid);
  // Initialize with caller phone if present
  session.phone = session.phone || normalizePhone(req.body.From || null);

  const greeting =
    "Hello, thank you for calling XYZ barbershop, how can I help you today?";
  const twiml = sayGather({
    prompt: greeting,
    action: "/voice/handle",
    hints: ["book", "reschedule", "cancel", "hours", "appointment", "tomorrow", "today"],
  });
  res.type("text/xml").send(twiml);
});

// 2) Handle each utterance → OpenAI → perform or ask for missing info → loop
app.post("/voice/handle", async (req, res) => {
  const callSid = req.body.CallSid || "no-sid";
  const session = getSession(callSid);
  session.phone = session.phone || normalizePhone(req.body.From || null);

  const speech = (req.body.SpeechResult || "").trim();
  if (!speech) {
    return res
      .type("text/xml")
      .send(sayGather({ prompt: "Sorry, I didn’t hear anything. How can I help?" }));
  }

  // Ask OpenAI for intent + slots, merging with what we already know
  const parsed = await extractIntentAndSlots(speech, {
    customer_name: session.name ?? null,
    phone_number: session.phone ?? null,
    appointment_time: session.time ?? null,
    appointment_id: session.apptId ?? null,
  });

  // Merge new info
  session.intent = parsed.intent || session.intent || "other";
  if (parsed.customer_name) session.name = parsed.customer_name;
  if (parsed.phone_number) session.phone = normalizePhone(parsed.phone_number);
  if (parsed.appointment_time) session.time = parsed.appointment_time;
  if (
    parsed.appointment_id !== null &&
    parsed.appointment_id !== undefined &&
    !Number.isNaN(Number(parsed.appointment_id))
  ) {
    session.apptId = Number(parsed.appointment_id);
  }

  // Branch by intent
  switch (session.intent) {
    case "greeting": {
      return res
        .type("text/xml")
        .send(
          sayGather({
            prompt:
              "Hi there! I can book, reschedule, or cancel an appointment, or tell you our hours. What would you like to do?",
          })
        );
    }

    case "hours": {
      return res.type("text/xml").send(
        sayGather({
          prompt: `${BUSINESS_HOURS} What else can I help you with?`,
        })
      );
    }

    case "cancel": {
      // If they didn’t specify which appt, cancel latest by their phone
      const phone = session.phone;
      if (!phone) {
        return res
          .type("text/xml")
          .send(
            sayGather({
              prompt:
                "What phone number is the appointment under?",
              hints: ["eight one three ..."],
            })
          );
      }

      let idToCancel = session.apptId || null;
      if (!idToCancel) {
        const latest = db
          .prepare(
            `SELECT id, appointment_time FROM appointments
             WHERE phone_number = ?
             ORDER BY id DESC LIMIT 1`
          )
          .get(phone);
        if (!latest) {
          return res
            .type("text/xml")
            .send(
              sayGather({
                prompt:
                  "I couldn’t find an appointment on that number. Would you like to book one instead?",
              })
            );
        }
        idToCancel = latest.id;
      }

      const info = db.prepare("DELETE FROM appointments WHERE id = ?").run(idToCancel);
      const ok = info.changes > 0;
      clearSession(callSid);
      return res
        .type("text/xml")
        .send(
          sayThenHangup(
            ok
              ? "Your appointment has been cancelled. Thanks for calling!"
              : "I couldn’t find that appointment, but I can help with something else next time. Goodbye!"
          )
        );
    }

    case "reschedule": {
      const phone = session.phone;
      if (!phone) {
        return res
          .type("text/xml")
          .send(
            sayGather({
              prompt:
                "What phone number is the appointment under?",
            })
          );
      }

      // Need a new time
      if (!session.time) {
        return res
          .type("text/xml")
          .send(
            sayGather({
              prompt: "Sure — what new date and time would you like?",
              hints: ["tomorrow 3 pm", "next Friday at 2"],
            })
          );
      }

      // Reschedule latest by phone (simple demo logic)
      const latest = db
        .prepare(
          `SELECT id FROM appointments
           WHERE phone_number = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(phone);
      if (!latest) {
        return res
          .type("text/xml")
          .send(
            sayGather({
              prompt:
                "I couldn’t find an appointment under that number. Would you like me to book one instead?",
            })
          );
      }

      db.prepare("UPDATE appointments SET appointment_time = ? WHERE id = ?").run(
        session.time,
        latest.id
      );

      clearSession(callSid);
      return res
        .type("text/xml")
        .send(
          sayThenHangup(
            `All set — your appointment has been moved to ${session.time}. Thanks for calling!`
          )
        );
    }

    case "book": {
      // Need name, phone, time
      if (!session.name) {
        return res
          .type("text/xml")
          .send(
            sayGather({
              prompt: "Great — what name should I put the appointment under?",
              hints: ["Michael", "John", "Sarah"],
            })
          );
      }
      if (!session.phone) {
        return res
          .type("text/xml")
          .send(
            sayGather({
              prompt: "What phone number should I use for your appointment?",
              hints: ["eight one three ..."],
            })
          );
      }
      if (!session.time) {
        return res
          .type("text/xml")
          .send(
            sayGather({
              prompt: "What day and time would you like?",
              hints: ["tomorrow 10 am", "Saturday 2 pm"],
            })
          );
      }

      // Create the appointment
      db.prepare(
        `INSERT INTO appointments (customer_name, phone_number, appointment_time)
         VALUES (?, ?, ?)`
      ).run(session.name, session.phone, session.time);

      clearSession(callSid);
      return res
        .type("text/xml")
        .send(
          sayThenHangup(
            `Perfect — you're booked, ${session.name}, for ${session.time}. We’ll see you soon!`
          )
        );
    }

    case "goodbye": {
      clearSession(callSid);
      return res.type("text/xml").send(sayThenHangup("Thanks for calling. Goodbye!"));
    }

    default: {
      // Unknown → reprompt
      return res
        .type("text/xml")
        .send(
          sayGather({
            prompt:
              "I can help you book, reschedule, or cancel an appointment, or tell you our hours. What would you like to do?",
          })
        );
    }
  }
});

// -------------------- Simple REST API (keep for testing/admin) --------------------
app.post("/make-appointment", (req, res) => {
  const { customer_name, phone_number, appointment_time } = req.body || {};
  if (!customer_name || !phone_number || !appointment_time) {
    return res.json({
      success: false,
      error: "Missing fields. Required: customer_name, phone_number, appointment_time",
    });
  }
  db.prepare(
    `INSERT INTO appointments (customer_name, phone_number, appointment_time) VALUES (?, ?, ?)`
  ).run(customer_name, phone_number, appointment_time);
  res.json({ success: true, message: "Appointment booked!" });
});

app.get("/appointments", (req, res) => {
  const { phone } = req.query;
  const rows = phone
    ? db.prepare("SELECT * FROM appointments WHERE phone_number = ? ORDER BY id DESC").all(phone)
    : db.prepare("SELECT * FROM appointments ORDER BY id DESC").all();
  res.json(rows);
});

app.get("/appointments/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
  if (!row) return res.json({ success: false, error: "Appointment not found" });
  res.json(row);
});

app.put("/appointments/:id", (req, res) => {
  const { appointment_time } = req.body || {};
  if (!appointment_time) return res.json({ success: false, error: "appointment_time required" });
  const info = db.prepare("UPDATE appointments SET appointment_time = ? WHERE id = ?").run(
    appointment_time,
    req.params.id
  );
  if (!info.changes) return res.json({ success: false, error: "Appointment not found" });
  res.json({ success: true, message: "Appointment updated" });
});

app.delete("/appointments/:id", (req, res) => {
  const info = db.prepare("DELETE FROM appointments WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.json({ success: false, error: "Appointment not found" });
  res.json({ success: true, message: "Appointment deleted" });
});

// Health & DB check
app.get("/health", (_req, res) => res.send("ok"));
app.get("/test-db", (_req, res) => {
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM appointments").get();
    res.send(`Database is working. Appointments stored: ${row.count}`);
  } catch (e) {
    res.status(500).send("DB error: " + e.message);
  }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
