import db from "./database.js";
import "dotenv/config";
import express from "express";

const app = express();

// Twilio sends form-encoded bodies for <Gather> results
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---- safety: ensure OPENAI_API_KEY is present ----
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing! Set it in Render > Environment.");
  process.exit(1);
}

// ------------ helpers ------------
function twimlSayGather(message, { action = "/voice/handle", bargeIn = true } = {}) {
  // Ask a question and keep the mic open to capture speech
  return `
    <Response>
      <Gather input="speech" action="${action}" method="POST"
              language="en-US" speechTimeout="auto" profanityFilter="false"
              enhanced="true" bargeIn="${bargeIn}">
        <Say voice="alice">${xmlEscape(message)}</Say>
      </Gather>
      <Say voice="alice">I didn't catch that. Let me try again.</Say>
      <Redirect method="POST">${action}</Redirect>
    </Response>
  `.trim();
}

function twimlSay(message) {
  return `
    <Response>
      <Say voice="alice">${xmlEscape(message)}</Say>
      <Hangup/>
    </Response>
  `.trim();
}

function xmlEscape(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Simple in-memory per-call state
const sessions = new Map(); // key = CallSid, value = {intent, name, phone, time, barber}

// Call OpenAI to extract an intent + fields from user text
async function extractIntentAndSlots(userText) {
  const system = `
You are a call assistant for a barber shop. Extract structured info from the user's sentence.
Return ONLY JSON with this schema:
{
  "intent": "book" | "reschedule" | "cancel" | "hours" | "greet" | "agent" | "unknown",
  "customer_name": string | null,
  "phone_number": string | null,
  "appointment_time": string | null, // ISO-ish or natural text like "next Thursday 3pm"
  "barber": string | null
}
- Map small talk like "hi"/"hello" to intent "greet".
- If they ask to speak to a person, use "agent".
- Be liberal: recognize "book me", "set me up", "move it", "change it", etc.
- If anything is missing, set that field to null.
`;

  const body = {
    model: "gpt-4o-mini",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "intent",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: "string", enum: ["book", "reschedule", "cancel", "hours", "greet", "agent", "unknown"] },
            customer_name: { type: ["string", "null"] },
            phone_number: { type: ["string", "null"] },
            appointment_time: { type: ["string", "null"] },
            barber: { type: ["string", "null"] }
          },
          required: ["intent", "customer_name", "phone_number", "appointment_time", "barber"]
        }
      }
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText || "" }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const errText = await r.text();
    console.error("OpenAI error:", r.status, errText);
    return { intent: "unknown", customer_name: null, phone_number: null, appointment_time: null, barber: null };
  }

  const data = await r.json();
  const json = safeParseJSON(data?.choices?.[0]?.message?.content);
  return json || { intent: "unknown", customer_name: null, phone_number: null, appointment_time: null, barber: null };
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Normalize phone (very light)
function normalizePhone(p) {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return digits;       // US local
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || null;
}

// ------------- VOICE BOT ROUTES -------------

// Entry point Twilio calls on inbound call
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || Math.random().toString(36).slice(2);
  sessions.set(callSid, sessions.get(callSid) || {});

  // Friendly greeting + open mic
  const msg = `Hello! This is the barber shop. How can I help you today?
You can say things like: "Book me for Friday at 3 pm", "Reschedule my appointment", "Cancel my appointment", or "What are your hours?"`;
  res.type("text/xml").send(twimlSayGather(msg, { action: "/voice/handle" }));
});

// Handles speech turn
app.post("/voice/handle", async (req, res) => {
  const callSid = req.body.CallSid || "missing";
  const speech = (req.body.SpeechResult || "").trim();
  const session = sessions.get(callSid) || {};

  // If Twilio sent nothing, reprompt
  if (!speech) {
    return res.type("text/xml").send(
      twimlSayGather("Sorry — I didn’t catch that. How can I help?")
    );
  }

  // First, try to interpret what they said
  const nlp = await extractIntentAndSlots(speech);

  // Merge into session (don’t overwrite existing non-null with null)
  if (nlp.intent && nlp.intent !== "unknown") session.intent = nlp.intent;
  session.customer_name = session.customer_name ?? nlp.customer_name ?? null;
  session.phone_number  = session.phone_number  ?? normalizePhone(nlp.phone_number) ?? null;
  session.appointment_time = session.appointment_time ?? nlp.appointment_time ?? null;
  session.barber = session.barber ?? nlp.barber ?? null;

  sessions.set(callSid, session);

  // Branch by intent
  switch (session.intent) {
    case "greet":
      return res.type("text/xml").send(
        twimlSayGather("Hi! I can book, reschedule, cancel, or tell you our hours. What would you like to do?")
      );

    case "hours":
      return res.type("text/xml").send(
        twimlSay("We’re open Monday through Saturday, 9 am to 6 pm. Thanks for calling!")
      );

    case "agent":
      return res.type("text/xml").send(
        twimlSay("Okay, I’ll get a person. Please hold while I connect you.")
      );

    case "cancel":
      // Need phone + possibly time to identify
      if (!session.phone_number) {
        return res.type("text/xml").send(
          twimlSayGather("What phone number is the appointment under? You can say it like 8 1 3, 6 0 7, 4 9 8 9.")
        );
      }
      // Delete by phone + (optional) time match
      const toDelete = db.prepare(`
        SELECT id FROM appointments
        WHERE phone_number = ?
        ORDER BY id DESC LIMIT 1
      `).get(session.phone_number);

      if (!toDelete) {
        return res.type("text/xml").send(
          twimlSay("I couldn't find an appointment under that number. If you want to try again, please call back. Goodbye!")
        );
      }
      db.prepare(`DELETE FROM appointments WHERE id = ?`).run(toDelete.id);
      return res.type("text/xml").send(
        twimlSay("All set — your appointment has been cancelled. Thanks for calling!")
      );

    case "reschedule":
      // Need phone + new time
      if (!session.phone_number) {
        return res.type("text/xml").send(
          twimlSayGather("What phone number is the appointment under?")
        );
      }
      if (!session.appointment_time) {
        return res.type("text/xml").send(
          twimlSayGather("Sure — what time would you like instead?")
        );
      }
      // Update the latest appt by phone
      const latest = db.prepare(`
        SELECT id FROM appointments
        WHERE phone_number = ?
        ORDER BY id DESC LIMIT 1
      `).get(session.phone_number);

      if (!latest) {
        return res.type("text/xml").send(
          twimlSay("I couldn't find an appointment under that number. If you want to book a new one, just say 'book'. Goodbye!")
        );
      }
      db.prepare(`UPDATE appointments SET appointment_time = ? WHERE id = ?`)
        .run(session.appointment_time, latest.id);

      return res.type("text/xml").send(
        twimlSay("Great — you’re rescheduled. You’ll get a confirmation text if enabled. Thanks and have a great day!")
      );

    case "book":
      // Need name, phone, time (barber optional)
      if (!session.customer_name) {
        return res.type("text/xml").send(
          twimlSayGather("What name should I put the appointment under?")
        );
      }
      if (!session.phone_number) {
        return res.type("text/xml").send(
          twimlSayGather("What phone number should I use for the booking?")
        );
      }
      if (!session.appointment_time) {
        return res.type("text/xml").send(
          twimlSayGather("What time would you like?")
        );
      }
      // Save it
      db.prepare(`
        INSERT INTO appointments (customer_name, phone_number, appointment_time)
        VALUES (?, ?, ?)
      `).run(session.customer_name, session.phone_number, session.appointment_time);

      return res.type("text/xml").send(
        twimlSay(`You're all set, ${session.customer_name}. See you then!`)
      );

    default:
      // Unknown — ask them again
      return res.type("text/xml").send(
        twimlSayGather("I can book, reschedule, cancel, or tell you our hours. What would you like to do?")
      );
  }
});

// ------------- your existing REST endpoints (kept) -------------

// Quick test of DB health
app.get("/test-db", (req, res) => {
  try {
    const rowCount = db.prepare("SELECT COUNT(*) as count FROM appointments").get();
    res.send(`Database is working ✅. Appointments stored: ${rowCount.count}`);
  } catch (err) {
    res.status(500).send("Database error ✗ " + err.message);
  }
});

// REST: make appointment (from earlier)
app.post("/make-appointment", (req, res) => {
  const { customer_name, phone_number, appointment_time } = req.body || {};
  if (!customer_name || !phone_number || !appointment_time) {
    return res.json({ success: false, error: "Missing fields. Required: customer_name, phone_number, appointment_time" });
  }
  db.prepare(`INSERT INTO appointments (customer_name, phone_number, appointment_time) VALUES (?, ?, ?)`)
    .run(customer_name, phone_number, appointment_time);
  res.json({ success: true, message: "Appointment booked!" });
});

// REST: list, get, update, delete
app.get("/appointments", (req, res) => {
  const phone = req.query.phone ? req.query.phone.replace(/\D/g, "") : null;
  const q = phone
    ? db.prepare("SELECT * FROM appointments WHERE phone_number = ? ORDER BY id DESC").all(phone)
    : db.prepare("SELECT * FROM appointments ORDER BY id DESC").all();
  res.json(q);
});

app.get("/appointments/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
  if (!row) return res.json({ success: false, error: "Appointment not found" });
  res.json(row);
});

app.put("/appointments/:id", (req, res) => {
  const { appointment_time } = req.body || {};
  if (!appointment_time) return res.json({ success: false, error: "Missing appointment_time" });
  const info = db.prepare("UPDATE appointments SET appointment_time = ? WHERE id = ?").run(appointment_time, req.params.id);
  if (!info.changes) return res.json({ success: false, error: "Appointment not found" });
  res.json({ success: true, message: "Appointment updated" });
});

app.delete("/appointments/:id", (req, res) => {
  const info = db.prepare("DELETE FROM appointments WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.json({ success: false, error: "Appointment not found" });
  res.json({ success: true, message: "Appointment deleted" });
});

// ------------- start (Render will set PORT) -------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
