// ===== Conversational voice assistant =====
import fetch from "node-fetch"; // if not already available in your Node runtime

// A tiny in-memory state per active call (good enough for MVP)
const callSessions = new Map();

// Unified helper to return TwiML with a natural voice & speech gather
function sayAndListen({ text, action = "/voice/handle", loop = 1 }) {
  // SSML inside <Say> works best with Polly neural voices
  // You can try: Polly.Joanna-Neural, Polly.Matthew-Neural, Polly.Ruth-Neural, etc.
  return `
    <Response>
      <Gather 
        input="speech"
        action="${action}"
        method="POST"
        enhanced="true"
        language="en-US"
        speechTimeout="auto"
        bargeIn="true"
        hints="book,cancel,reschedule,appointment,hours,${["John","Mike","Sarah"].join(",")}"
      >
        <Say voice="Polly.Joanna-Neural">
          <speak>
            <prosody rate="medium" pitch="+2%">
              ${text}
            </prosody>
          </speak>
        </Say>
      </Gather>
      <!-- If caller stays silent, gently reprompt once -->
      <Say loop="${loop}" voice="Polly.Joanna-Neural">
        <speak>
          <prosody rate="medium" pitch="+2%">
            I didn't catch that. Please say something like book, cancel, or reschedule an appointment.
          </prosody>
        </speak>
      </Say>
      <Redirect method="POST">/voice</Redirect>
    </Response>
  `.trim();
}

// First response when a call arrives
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || "no-sid";
  // Initialize/reset a session for this call
  callSessions.set(callSid, { stage: "start", intent: null, slots: {} });
  const welcome =
    "Hello! This is the barber shop. How can I help you today? You can say things like, book an appointment, reschedule, cancel, or ask our hours.";
  res.type("text/xml").send(sayAndListen({ text: welcome }));
});

// Helper: call OpenAI to interpret the user's utterance
async function interpretUtterance(utterance) {
  const sys = `
You are a concise call receptionist for a barber shop. 
Extract intent and any details as JSON ONLY (no extra text). 
Valid intents: "book", "cancel", "reschedule", "hours", "greeting", "goodbye", "unknown".
Fields: 
- "name" (string, optional)
- "phone" (string, optional)
- "datetime" (ISO-ish or natural like "tomorrow 2pm")
- "barber" (string, optional)
Return: {"intent":"...", "name":"...", "phone":"...", "datetime":"...", "barber":"..."}.
If anything is missing, keep fields empty.
`.trim();

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: utterance || "" },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  let data = {};
  try {
    data = JSON.parse(j.choices?.[0]?.message?.content || "{}");
  } catch (_) {
    data = {};
  }
  return {
    intent: data.intent || "unknown",
    name: data.name || "",
    phone: data.phone || "",
    datetime: data.datetime || "",
    barber: data.barber || "",
  };
}

// Slot-filling utility: check what we still need for an operation
function missingFor(intent, slots) {
  const needs = [];
  if (intent === "book") {
    if (!slots.datetime) needs.push("datetime");
    if (!slots.name) needs.push("name");
    // optional: phone, barber
  }
  if (intent === "reschedule") {
    if (!slots.id && !slots.phone) needs.push("id_or_phone");
    if (!slots.datetime) needs.push("datetime");
  }
  if (intent === "cancel") {
    if (!slots.id && !slots.phone) needs.push("id_or_phone");
  }
  return needs;
}

// Turn user speech into next system prompt + do DB if complete
async function handleIntent(session, text) {
  const parsed = await interpretUtterance(text);
  // Merge slots
  session.intent = session.intent || parsed.intent;
  session.slots = { ...session.slots, ...parsed };

  // Normalize trivial intents
  if (session.intent === "greeting") return { reply: "Hi there! What can I do for you today?" };
  if (session.intent === "hours") {
    return { reply: "We are open Tuesday through Saturday from 9 AM to 6 PM. Would you like to book an appointment?" };
  }
  if (session.intent === "goodbye") return { reply: "Thanks for calling. Have a great day!" };
  if (!["book","cancel","reschedule","hours","goodbye"].includes(session.intent)) {
    return { reply: "I can help you book, cancel, or reschedule. What would you like to do?" };
  }

  // Ask for missing info
  const needs = missingFor(session.intent, session.slots);
  if (needs.length) {
    if (needs.includes("datetime")) return { reply: "What day and time would you like?" };
    if (needs.includes("name")) return { reply: "What name should I put the appointment under?" };
    if (needs.includes("id_or_phone")) return { reply: "Please say your appointment ID, or the phone number on the appointment." };
  }

  // If we reach here, we have enough to act
  try {
    if (session.intent === "book") {
      // Create appointment
      const stmt = db.prepare(
        "INSERT INTO appointments (customer_name, phone_number, appointment_time) VALUES (?, ?, ?)"
      );
      stmt.run(session.slots.name || "Walk-in", session.slots.phone || "", session.slots.datetime);
      return { reply: `All set. I booked ${session.slots.name || "your"} appointment for ${session.slots.datetime}. Anything else?` };
    }

    if (session.intent === "reschedule") {
      // Simple reschedule by phone (or you can require ID)
      if (session.slots.id) {
        const up = db.prepare("UPDATE appointments SET appointment_time = ? WHERE id = ?");
        const info = up.run(session.slots.datetime, Number(session.slots.id));
        if (info.changes) return { reply: `Done. Your appointment is now ${session.slots.datetime}. Anything else?` };
        return { reply: "I couldn't find that appointment ID. Would you like to try a phone number instead?" };
      } else {
        const row = db.prepare("SELECT id FROM appointments WHERE phone_number = ? ORDER BY id DESC").get(session.slots.phone || "");
        if (!row) return { reply: "I couldn't find an appointment under that phone number. Would you like to try the appointment ID?" };
        const up = db.prepare("UPDATE appointments SET appointment_time = ? WHERE id = ?");
        up.run(session.slots.datetime, row.id);
        return { reply: `Done. Your appointment is now ${session.slots.datetime}. Anything else?` };
      }
    }

    if (session.intent === "cancel") {
      if (session.slots.id) {
        const del = db.prepare("DELETE FROM appointments WHERE id = ?");
        const info = del.run(Number(session.slots.id));
        if (info.changes) return { reply: "Your appointment has been canceled. Anything else I can help with?" };
        return { reply: "I couldn't find that appointment ID. Would you like to try a phone number instead?" };
      } else {
        const row = db.prepare("SELECT id FROM appointments WHERE phone_number = ? ORDER BY id DESC").get(session.slots.phone || "");
        if (!row) return { reply: "I couldn't find an appointment under that phone number. Would you like to try the appointment ID?" };
        const del = db.prepare("DELETE FROM appointments WHERE id = ?");
        del.run(row.id);
        return { reply: "Your appointment has been canceled. Anything else I can help with?" };
      }
    }

    return { reply: "Okay. What would you like to do next?" };
  } catch (e) {
    console.error("DB error:", e);
    return { reply: "Sorry, I had a problem saving that. Could you try again?" };
  }
}

app.post("/voice/handle", async (req, res) => {
  const callSid = req.body.CallSid || "no-sid";
  const session = callSessions.get(callSid) || { stage: "start", intent: null, slots: {} };

  const speech = (req.body.SpeechResult || "").trim();
  if (!speech) {
    return res.type("text/xml").send(
      sayAndListen({ text: "Sorry, I didn't hear anything. What can I help you with?" })
    );
  }

  const { reply } = await handleIntent(session, speech);
  // Keep session around for next turn
  callSessions.set(callSid, session);

  res.type("text/xml").send(sayAndListen({ text: reply }));
});
