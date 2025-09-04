// server.js
// Conversational phone assistant w/ OpenAI + Twilio Speech + SQLite

import express from "express";
import "dotenv/config";
import db from "./database.js";

const app = express();

// Twilio posts application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- required env ---
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY (Render → Environment).");
  process.exit(1);
}

// --- Business config ---
const BUSINESS_NAME = "XYZ barbershop";
const BUSINESS_HOURS_TEXT = "We are open Tuesday to Saturday, 8 AM to 8 PM.";
const VOICE = "Polly.Matthew-Neural";

// --- Per-call session (simple in-memory) ---
// states: AWAIT_INTENT | BOOK_AWAIT_TIME | BOOK_AWAIT_NAME | RESCHED_AWAIT_TIME | CANCEL_CONFIRM
const sessions = new Map(); // CallSid -> { state, intent, name, phone, time, apptId }

function sess(callSid) {
  if (!sessions.has(callSid)) sessions.set(callSid, { state: "AWAIT_INTENT" });
  return sessions.get(callSid);
}
function clear(callSid) {
  sessions.delete(callSid);
}

// --- helpers ---
function normalizePhone(e164) {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  return digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
}
function sayGather({ text, action = "/voice/handle", hints = [] }) {
  return `
    <Response>
      <Gather input="speech"
              action="${action}"
              method="POST"
              speechTimeout="auto"
              enhanced="true"
              language="en-US"
              bargeIn="true"
              hints="${hints.join(",")}">
        <Say voice="${VOICE}">${text}</Say>
      </Gather>
      <Say voice="${VOICE}">Sorry, I didn't catch that.</Say>
      <Redirect method="POST">/voice</Redirect>
    </Response>
  `.trim();
}
function sayHangup(text) {
  return `
    <Response>
      <Say voice="${VOICE}">${text}</Say>
      <Hangup/>
    </Response>
  `.trim();
}

// --- OpenAI intent & slot extraction ---
async function extractIntent(utterance, known = {}) {
  const system = `
You are a concise, friendly call receptionist for a barber shop.
Return ONLY strict JSON, no extra text, matching this schema:
{
  "intent": "book"|"reschedule"|"cancel"|"hours"|"greeting"|"goodbye"|"other",
  "customer_name": string|null,
  "phone_number": string|null,
  "appointment_time": string|null,  // free text OK ("tomorrow 3pm")
  "appointment_id": number|null
}
If caller says they want to book, intent="book".
If asks to change/move time, intent="reschedule".
If asks to cancel, intent="cancel".
If asks for open/close times, intent="hours".
If says hello, intent="greeting"; if ending the call, intent="goodbye".
Do not include any text outside the JSON object.
  `.trim();

  const user = `Caller said: "${utterance}"
Known so far: ${JSON.stringify(known)}`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return {
      intent: parsed.intent || "other",
      name: parsed.customer_name ?? null,
      phone: parsed.phone_number ?? null,
      time: parsed.appointment_time ?? null,
      apptId: parsed.appointment_id ?? null,
      _raw: raw,
    };
  } catch (e) {
    console.error("OpenAI parse error:", e);
    return { intent: "other", name: null, phone: null, time: null, apptId: null, _raw: "{}" };
  }
}

// ---------- VOICE FLOW ----------

// 1) Greeting + listen
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || "no-sid";
  const s = sess(callSid);
  s.state = "AWAIT_INTENT";
  s.phone = s.phone || normalizePhone(req.body.From || null);

  const greeting = "Hello, thank you for calling XYZ barbershop, how can I help you today?";
  res.type("text/xml").send(
    sayGather({
      text: greeting,
      action: "/voice/handle",
      hints: ["book", "reschedule", "cancel", "hours", "appointment", "tomorrow", "today"],
    })
  );
});

// 2) Handle each user turn
app.post("/voice/handle", async (req, res) => {
  const callSid = req.body.CallSid || "no-sid";
  const s = sess(callSid);
  s.phone = s.phone || normalizePhone(req.body.From || null);

  const utter = (req.body.SpeechResult || "").trim();
  if (!utter) {
    return res.type("text/xml").send(
      sayGather({ text: "Sorry, I didn’t hear anything. How can I help?" })
    );
  }

  // Interpret with OpenAI; also keep a simple keyword fallback for reliability
  const ai = await extractIntent(utter, {
    customer_name: s.name ?? null,
    phone_number: s.phone ?? null,
    appointment_time: s.time ?? null,
    appointment_id: s.apptId ?? null,
  });

  // Debug logs (see Render Logs)
  console.log("🗣 Speech:", utter);
  console.log("🤖 Parsed:", ai);

  // Merge newly found info
  if (ai.name) s.name = ai.name;
  if (ai.phone) s.phone = normalizePhone(ai.phone);
  if (ai.time) s.time = ai.time;
  if (ai.apptId !== null && ai.apptId !== undefined && !Number.isNaN(Number(ai.apptId))) {
    s.apptId = Number(ai.apptId);
  }

  // Decide/advance intent + state
  let intent = ai.intent;

  // keyword fallback if model said "other"
  const low = utter.toLowerCase();
  if (intent === "other") {
    if (/(book|schedule|set.*appointment)/.test(low)) intent = "book";
    else if (/(resched|change|move)/.test(low)) intent = "reschedule";
    else if (/cancel/.test(low)) intent = "cancel";
    else if (/(hour|open|close)/.test(low)) intent = "hours";
    else if (/(bye|goodbye|that.s all|no thanks)/.test(low)) intent = "goodbye";
    else if (/(hi|hello|hey)/.test(low)) intent = "greeting";
  }

  // State machine
  switch (s.state) {
    case "AWAIT_INTENT": {
      if (intent === "greeting") {
        return res.type("text/xml").send(
          sayGather({
            text: "Hi! I can book, reschedule, or cancel an appointment, or tell you our hours. What would you like to do?",
          })
        );
      }
      if (intent === "hours") {
        return res.type("text/xml").send(
          sayGather({ text: `${BUSINESS_HOURS_TEXT} What else can I help you with?` })
        );
      }
      if (intent === "goodbye") {
        clear(callSid);
        return res.type("text/xml").send(sayHangup("Thanks for calling. Goodbye!"));
      }
      if (intent === "book") {
        // ask time first, then name (your requested flow)
        s.state = "BOOK_AWAIT_TIME";
        return res.type("text/xml").send(
          sayGather({
            text: "Sure — what day and time would you like?",
            hints: ["tomorrow 3 pm", "Friday at 2", "next Tuesday 10 am"],
          })
        );
      }
      if (intent === "reschedule") {
        s.state = "RESCHED_AWAIT_TIME";
        return res.type("text/xml").send(
          sayGather({
            text: "Okay — what new day and time would you like?",
            hints: ["tomorrow 4 pm", "Saturday at 1"],
          })
        );
      }
      if (intent === "cancel") {
        s.state = "CANCEL_CONFIRM";
        return res.type("text/xml").send(
          sayGather({ text: "Do you want me to cancel your latest appointment on this number?" })
        );
      }
      // unknown → reprompt
      return res.type("text/xml").send(
        sayGather({
          text: "I can help you book, reschedule, or cancel an appointment, or tell you our hours. What would you like to do?",
        })
      );
    }

    case "BOOK_AWAIT_TIME": {
      // If AI already pulled a time from utterance, we’ll have s.time; else take utter as time
      if (!s.time) s.time = utter;
      // Now ask for name
      s.state = "BOOK_AWAIT_NAME";
      return res.type("text/xml").send(
        sayGather({
          text: "Got it. What’s the first and last name for the appointment?",
          hints: ["John Smith", "Sarah Lee"],
        })
      );
    }

    case "BOOK_AWAIT_NAME": {
      if (!s.name) s.name = utter; // accept whatever they said as name
      if (!s.phone) s.phone = normalizePhone(req.body.From || ""); // default to caller ID
      try {
        db.prepare(
          `INSERT INTO appointments (customer_name, phone_number, appointment_time)
           VALUES (?, ?, ?)`
        ).run(s.name || "Customer", s.phone || "", s.time || "");
        clear(callSid);
        return res
          .type("text/xml")
          .send(sayHangup(`Perfect — you're booked, ${s.name || "friend"}, for ${s.time}. See you soon!`));
      } catch (e) {
        console.error("DB insert error:", e);
        // let them retry time
        s.state = "BOOK_AWAIT_TIME";
        return res
          .type("text/xml")
          .send(sayGather({ text: "Sorry, I had trouble saving that. What day and time did you want?" }));
      }
    }

    case "RESCHED_AWAIT_TIME": {
      if (!s.time) s.time = utter; // take as the new time
      const phone = s.phone;
      if (!phone) {
        // Shouldn’t happen since we default to caller-id, but ask if needed
        return res
          .type("text/xml")
          .send(sayGather({ text: "What phone number is the appointment under?" }));
      }
      const latest = db
        .prepare(
          `SELECT id FROM appointments
           WHERE phone_number = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(phone);
      if (!latest) {
        s.state = "AWAIT_INTENT";
        return res
          .type("text/xml")
          .send(
            sayGather({
              text: "I couldn’t find an appointment under this number. Would you like me to book one instead?",
            })
          );
      }
      try {
        db.prepare("UPDATE appointments SET appointment_time = ? WHERE id = ?").run(s.time, latest.id);
        clear(callSid);
        return res.type("text/xml").send(sayHangup(`All set — I moved it to ${s.time}. Thanks for calling!`));
      } catch (e) {
        console.error("DB update error:", e);
        return res
          .type("text/xml")
          .send(sayGather({ text: "Sorry, there was a problem updating that. What new time would you like?" }));
      }
    }

    case "CANCEL_CONFIRM": {
      const yes = /(yes|yeah|yep|correct|do it|please)/i.test(utter);
      if (!yes) {
        s.state = "AWAIT_INTENT";
        return res
          .type("text/xml")
          .send(sayGather({ text: "Okay, I’ll keep it. What else can I help with?" }));
      }
      const phone = s.phone;
      if (!phone) {
        return res
          .type("text/xml")
          .send(sayGather({ text: "What phone number is the appointment under?" }));
      }
      const latest = db
        .prepare(
          `SELECT id FROM appointments
           WHERE phone_number = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(phone);
      if (!latest) {
        s.state = "AWAIT_INTENT";
        return res
          .type("text/xml")
          .send(sayGather({ text: "I couldn’t find an appointment under this number. Anything else?" }));
      }
      try {
        db.prepare("DELETE FROM appointments WHERE id = ?").run(latest.id);
        clear(callSid);
        return res.type("text/xml").send(sayHangup("Your appointment has been cancelled. Goodbye!"));
      } catch (e) {
        console.error("DB delete error:", e);
        s.state = "AWAIT_INTENT";
        return res
          .type("text/xml")
          .send(sayGather({ text: "Sorry, something went wrong. What else can I help with?" }));
      }
    }

    default: {
      s.state = "AWAIT_INTENT";
      return res
        .type("text/xml")
        .send(
          sayGather({
            text: "I can help you book, reschedule, or cancel an appointment, or tell you our hours. What would you like to do?",
          })
        );
    }
  }
});

// ---------- Simple REST API (unchanged) ----------
app.post("/make-appointment", (req, res) => {
  const { customer_name, phone_number, appointment_time } = req.body || {};
  if (!customer_name || !phone_number || !appointment_time) {
    return res.json({
      success: false,
      error: "Missing fields. Required: customer_name, phone_number, appointment_time",
    });
  }
  db.prepare(
    `INSERT INTO appointments (customer_name, phone_number, appointment_time)
     VALUES (?, ?, ?)`
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

// Health routes
app.get("/health", (_req, res) => res.send("ok"));
app.get("/test-db", (_req, res) => {
  try {
    const c = db.prepare("SELECT COUNT(*) AS count FROM appointments").get();
    res.send(`Database is working. Appointments stored: ${c.count}`);
  } catch (e) {
    res.status(500).send("DB error: " + e.message);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
