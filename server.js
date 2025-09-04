// server.js — Realtime voice + Google Calendar sync + SQLite
import 'dotenv/config';
import express from 'express';
import db from './database.js';
import { WebSocketServer } from 'ws';
import { google } from 'googleapis';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ─────────── config ─────────── */
const BUSINESS_NAME = 'XYZ barbershop';
const HOURS_TEXT = 'We are open Tuesday to Saturday, 8 AM to 8 PM.';
const TZ = process.env.TZ || 'America/New_York';
const POLLY_VOICE = 'Polly.Matthew-Neural'; // fallback Say
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const CALENDAR_ID = process.env.CALENDAR_ID || 'primary';

/* ─────────── sanity env ─────────── */
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

/* ─────────── DB migration (safe) ─────────── */
try { db.prepare('ALTER TABLE appointments ADD COLUMN google_event_id TEXT').run(); } catch (_) {}

/* ─────────── Google Calendar client ─────────── */
function makeGAuth() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

async function gcalCreateEvent({ summary, description, startISO, endISO }) {
  const calendar = makeGAuth();
  if (!calendar) return { id: null, ok: false, error: 'gcal not configured' };
  const res = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ },
    },
  });
  return { id: res.data.id || null, ok: true };
}

async function gcalUpdateEvent({ eventId, summary, description, startISO, endISO }) {
  const calendar = makeGAuth();
  if (!calendar || !eventId) return { ok: false };
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: {
      summary, description,
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ },
    },
  });
  return { ok: true };
}

async function gcalDeleteEvent(eventId) {
  const calendar = makeGAuth();
  if (!calendar || !eventId) return { ok: false };
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
  return { ok: true };
}

/* ─────────── naïve time handling ─────────── */
function toEventTimes(isoOrPhrase) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(isoOrPhrase)) {
    const start = new Date(isoOrPhrase);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

/* ─────────── OpenAI (Realtime + tools) ─────────── */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools = [
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Create a new appointment',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'First and last name' },
          phone: { type: 'string', description: 'Digits only' },
          datetime: { type: 'string', description: 'ISO-like e.g. 2025-09-06T15:00' }
        },
        required: ['name', 'phone', 'datetime']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_latest_by_phone',
      description: 'Reschedule the caller’s most recent appointment by phone',
      parameters: {
        type: 'object',
        properties: { phone: { type: 'string' }, new_datetime: { type: 'string' } },
        required: ['phone', 'new_datetime']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_latest_by_phone',
      description: 'Cancel the caller’s most recent appointment by phone',
      parameters: {
        type: 'object',
        properties: { phone: { type: 'string' } },
        required: ['phone']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_hours',
      description: 'Say business hours',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_followup',
      description: 'Ask a short question for missing info',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question']
      }
    }
  }
];

async function execTool(name, args) {
  switch (name) {
    case 'book_appointment': {
      const { name, phone, datetime } = args;
      const { startISO, endISO } = toEventTimes(datetime);
      const g = await gcalCreateEvent({
        summary: `Haircut — ${name}`,
        description: `Booked by phone ${phone}`,
        startISO, endISO
      });
      db.prepare(
        'INSERT INTO appointments (customer_name, phone_number, appointment_time, google_event_id) VALUES (?, ?, ?, ?)'
      ).run(name, phone, datetime, g.id || null);
      return { speak: `Booked ${name} for ${datetime}.` };
    }
    case 'reschedule_latest_by_phone': {
      const { phone, new_datetime } = args;
      const row = db.prepare(
        'SELECT id, google_event_id FROM appointments WHERE phone_number = ? ORDER BY id DESC LIMIT 1'
      ).get(phone);
      if (!row) return { speak: 'I could not find an appointment on that number. Want me to book one instead?' };
      const { startISO, endISO } = toEventTimes(new_datetime);
      if (row.google_event_id) {
        await gcalUpdateEvent({ eventId: row.google_event_id, startISO, endISO });
      }
      db.prepare('UPDATE appointments SET appointment_time = ? WHERE id = ?')
        .run(new_datetime, row.id);
      return { speak: `All set. I moved it to ${new_datetime}.` };
    }
    case 'cancel_latest_by_phone': {
      const { phone } = args;
      const row = db.prepare(
        'SELECT id, google_event_id FROM appointments WHERE phone_number = ? ORDER BY id DESC LIMIT 1'
      ).get(phone);
      if (!row) return { speak: 'I couldn’t find an appointment on that number.' };
      if (row.google_event_id) await gcalDeleteEvent(row.google_event_id);
      db.prepare('DELETE FROM appointments WHERE id = ?').run(row.id);
      return { speak: 'Your appointment has been cancelled.' };
    }
    case 'get_hours':
      return { speak: HOURS_TEXT };
    case 'ask_followup':
      return { speak: String(args.question || 'Could you clarify?') };
    default:
      return { speak: 'Sorry, I did not get that.' };
  }
}

/* ─────────── Realtime streaming bridge ───────────
   Twilio <Connect><Stream> -> wss:/twilio
   We open a second ws to OpenAI Realtime. Forward audio in, send audio out.
*/
let wss;
function ensureWSS(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/twilio')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (twilioWS) => {
    const rtURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
    const rt = new (await import('ws')).WebSocket(rtURL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let callerPhone = '';

    rt.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        // Audio from model to caller (base64 μ-law)
        if (data.type === 'response.audio.delta' && data.audio) {
          twilioWS.send(JSON.stringify({ event: 'media', media: { payload: data.audio } }));
        }

        // Tool calls
        if (data.type === 'response.function_call') {
          (async () => {
            const { name, arguments: argStr, call_id } = data;
            const args = argStr ? JSON.parse(argStr) : {};
            if (name && name.includes('by_phone') && callerPhone && !args.phone) {
              args.phone = callerPhone;
            }
            const result = await execTool(name, args);
            rt.send(JSON.stringify({
              type: 'response.function_call_output',
              call_id,
              output: JSON.stringify(result),
            }));
          })();
        }
      } catch (_) {}
    });

    rt.on('open', () => {
      // Tell Realtime exactly what audio formats we speak with Twilio, and enable VAD
      rt.send(JSON.stringify({
        type: 'session.update',
        session: {
          voice: 'verse',
          input_audio_format: { type: 'mulaw', sample_rate: 8000 },
          output_audio_format: { type: 'mulaw', sample_rate: 8000 },
          turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
          instructions: `
You are a warm, efficient phone receptionist for ${BUSINESS_NAME}.
Always speak concisely and naturally. Use tool calls when you need to book/reschedule/cancel,
or to state hours. For booking:
 - Ask for day/time first, then first & last name, then confirm phone if missing.
For rescheduling:
 - Ask for the new time if missing, and use the caller's phone to find the latest.
For cancel:
 - Confirm and use latest by phone.
Assume timezone ${TZ}. Speak as soon as you know what to say.
`,
          tools
        }
      }));

      // Initial greeting
      rt.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['audio'], instructions: 'Hello, thank you for calling XYZ barbershop, how can I help you today?' }
      }));
    });

    rt.on('close', () => twilioWS.close());
    rt.on('error', () => twilioWS.close());

    twilioWS.on('message', (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.event === 'start') {
          callerPhone = (evt?.start?.customParameters?.from || '').replace(/\D/g, '');
        } else if (evt.event === 'media') {
          // Forward caller audio (base64 μ-law/8k) to OpenAI
          rt.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: evt.media.payload }));
          // With server_vad enabled, the backend will determine when to respond.
        } else if (evt.event === 'stop') {
          rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          try { rt.close(); } catch {}
          try { twilioWS.close(); } catch {}
        }
      } catch (_) {}
    });

    twilioWS.on('close', () => { try { rt.close(); } catch (_) {} });
    twilioWS.on('error', () => { try { rt.close(); } catch (_) {} });
  });

  return wss;
}

/* ─────────── Twilio entry: start streaming ─────────── */
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${(req.body.From || '').replace(/"/g,'')}"/>
        </Stream>
      </Connect>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

/* ─────────── Fallback (non-streaming) ─────────── */
app.post('/voice-fallback', (req, res) => {
  const twiml = `
    <Response>
      <Gather input="speech" action="/voice-fallback-handle" method="POST" speechTimeout="auto">
        <Say voice="${POLLY_VOICE}">Hello, thank you for calling ${BUSINESS_NAME}, how can I help you today?</Say>
      </Gather>
      <Say voice="${POLLY_VOICE}">Sorry, I didn’t catch that.</Say>
      <Hangup/>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

app.post('/voice-fallback-handle', (_req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Say voice="${POLLY_VOICE}">Thanks! The realtime assistant is temporarily unavailable. Please try again later.</Say>
      <Hangup/>
    </Response>
  `.trim());
});

/* ─────────── REST API (kept) ─────────── */
app.post('/make-appointment', (req, res) => {
  const { customer_name, phone_number, appointment_time } = req.body || {};
  if (!customer_name || !phone_number || !appointment_time) {
    return res.json({ success: false, error: 'Missing fields. Required: customer_name, phone_number, appointment_time' });
  }
  db.prepare('INSERT INTO appointments (customer_name, phone_number, appointment_time, google_event_id) VALUES (?, ?, ?, ?)')
    .run(customer_name, phone_number, appointment_time, null);
  res.json({ success: true, message: 'Appointment booked!' });
});

app.get('/appointments', (req, res) => {
  const { phone } = req.query;
  const rows = phone
    ? db.prepare('SELECT * FROM appointments WHERE phone_number = ? ORDER BY id DESC').all(String(phone))
    : db.prepare('SELECT * FROM appointments ORDER BY id DESC').all();
  res.json(rows);
});

app.get('/appointments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!row) return res.json({ success: false, error: 'Appointment not found' });
  res.json(row);
});

app.put('/appointments/:id', (req, res) => {
  const { appointment_time } = req.body || {};
  if (!appointment_time) return res.json({ success: false, error: 'appointment_time required' });
  const info = db.prepare('UPDATE appointments SET appointment_time = ? WHERE id = ?').run(appointment_time, req.params.id);
  if (!info.changes) return res.json({ success: false, error: 'Appointment not found' });
  res.json({ success: true, message: 'Appointment updated' });
});

app.delete('/appointments/:id', (req, res) => {
  const info = db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.json({ success: false, error: 'Appointment not found' });
  res.json({ success: true, message: 'Appointment deleted' });
});

app.get('/health', (_req, res) => res.send('ok'));
app.get('/test-db', (_req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM appointments').get();
    res.send(`Database OK. Appointments: ${row.count}`);
  } catch (e) {
    res.status(500).send('DB error: ' + e.message);
  }
});

/* ─────────── start server & WS ─────────── */
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log('Server listening on', PORT));
ensureWSS(server);
