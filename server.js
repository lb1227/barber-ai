import 'dotenv/config';
import express from 'express';
import { OpenAI } from 'openai';
import twilio from 'twilio';

const app = express();

// Twilio sends webhooks as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));

// Keep tiny per-call history in memory (Render will reset on redeploys)
const memory = new Map(); // key: CallSid -> {history: [{role, content}, ...]}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---------- Utilities ----------
function twiml(res, twimlString) {
  res.set('Content-Type', 'text/xml');
  res.send(twimlString.trim());
}

function say(text, { voice = process.env.POLLY_VOICE || 'Polly.Matthew' } = {}) {
  // Twilio supports Polly.* voices when Polly is enabled on your account.
  // If you don’t want Polly, change voice to 'alice' or remove the voice attr.
  return `<Say voice="${voice}">${escapeXml(text)}</Say>`;
}

function escapeXml(s = '') {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function chatReply(callSid, userText) {
  // initialize history for this call
  if (!memory.has(callSid)) {
    memory.set(callSid, {
      history: [
        {
          role: 'system',
          content:
            "You are a friendly phone assistant for a barber shop. Keep replies short and conversational (1–2 sentences). If asked to book, collect date/time and name."
        }
      ]
    });
  }

  const state = memory.get(callSid);
  state.history.push({ role: 'user', content: userText });

  // Use a small, fast model; feel free to change to gpt-4o-mini or gpt-4o
  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    messages: state.history,
    temperature: 0.6,
    max_tokens: 120
  });

  const reply =
    resp.choices?.[0]?.message?.content?.trim() ||
    "Sorry, I didn't catch that. Could you repeat?";

  state.history.push({ role: 'assistant', content: reply });
  return reply;
}

// ---------- Routes ----------

// Health
app.get('/', (_req, res) => {
  res.type('text/plain').send('OK');
});

// 1) Entry: answer & prompt the caller, then <Gather> speech
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  // reset minimal memory if we’re starting fresh
  if (!memory.has(callSid)) {
    memory.set(callSid, { history: [] });
  }

  const welcome =
    "Hi! You're speaking with the barber assistant. How can I help you today?";

  // Gather speech with Twilio’s recognizer; send result to /gather
  const twimlResponse = `
    <Response>
      ${say(welcome)}
      <Gather
        input="speech"
        action="/gather"
        method="POST"
        language="en-US"
        hints="haircut, beard, appointment, today, tomorrow, morning, afternoon, evening"
        speechTimeout="auto"
        profanityFilter="false"
        enhanced="true">
        ${say("I'm listening.")}
      </Gather>
      ${say("Sorry, I didn't hear anything.")}
      <Redirect method="POST">/voice</Redirect>
    </Response>
  `;

  twiml(res, twimlResponse);
});

// 2) Handle the speech result, call OpenAI for a reply, speak it, and loop
app.post('/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const userText =
    (req.body.SpeechResult || '').trim() ||
    (req.body.TranscriptionText || '').trim();

  if (!userText) {
    const xml = `
      <Response>
        ${say("I didn't quite catch that.")}
        <Redirect method="POST">/voice</Redirect>
      </Response>
    `;
    return twiml(res, xml);
  }

  let reply = "Sorry, I didn’t catch that.";
  try {
    reply = await chatReply(callSid, userText);
  } catch (err) {
    console.error('OpenAI error:', err);
    reply = "I had trouble thinking just now. Please try again.";
  }

  // Simple exit intent
  const lower = userText.toLowerCase();
  const wantBye =
    /(^|\b)(bye|goodbye|hang up|that’s all|that is all|no thanks)(\b|$)/.test(
      lower
    );

  const xml = wantBye
    ? `
      <Response>
        ${say(reply)}
        ${say("Thanks for calling. Goodbye!")}
        <Hangup/>
      </Response>
    `
    : `
      <Response>
        ${say(reply)}
        <Pause length="0.3"/>
        <Redirect method="POST">/voice</Redirect>
      </Response>
    `;

  twiml(res, xml);
});

// Twilio (Render/Heroku) port binding
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
