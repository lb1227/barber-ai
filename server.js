// server.js — Twilio <-> OpenAI Realtime (g711_ulaw) + Google Calendar + SQLite
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import OpenAI from 'openai';
import { google } from 'googleapis';
import db from './database.js';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BUSINESS_NAME = 'XYZ barbershop';
const HOURS_TEXT = 'We are open Tuesday to Saturday, 8 AM to 8 PM.';
const TZ = process.env.TZ || 'America/New_York';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- DB migration (safe) ---------- */
try { db.prepare('ALTER TABLE appointments ADD COLUMN google_event_id TEXT').run(); } catch {}

/* ---------- Google Calendar ---------- */
function makeGAuth() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2 });
}
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

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
async function gcalCreateEvent({ summary, description, startISO, endISO }) {
  try {
    const calendar = makeGAuth();
    if (!calendar) return { id: null, ok: false, error: 'gcal not configured' };
    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: { summary, description, start: { dateTime: startISO, timeZone: TZ }, end: { dateTime: endISO, timeZone: TZ } }
    });
    return { id: res.data.id || null, ok: true };
  } catch (e) { console.error('GCAL create error:', e.message); return { id: null, ok: false }; }
}
async function gcalUpdateEvent({ eventId, summary, description, startISO, endISO }) {
  try {
    const calendar = makeGAuth();
    if (!calendar || !eventId) return { ok: false };
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: { summary, description, start: { dateTime: startISO, timeZone: TZ }, end: { dateTime: endISO, timeZone: TZ } }
    });
    return { ok: true };
  } catch (e) { console.error('GCAL update error:', e.message); return { ok: false }; }
}
async function gcalDeleteEvent(eventId) {
  try {
    const calendar = makeGAuth();
    if (!calendar || !eventId) return { ok: false };
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
  } catch (e) { console.error('GCAL delete error:', e.message); }
  return { ok: true };
}

/* ---------- Realtime tools (flat schema) ---------- */
const realtimeTools = [
  {
    type: 'function',
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
  },
  {
    type: 'function',
    name: 'reschedule_latest_by_phone',
    description: 'Reschedule the caller’s most recent appointment by phone',
    parameters: {
      type: 'object',
      properties: { phone: { type: 'string' }, new_datetime: { type: 'string' } },
      required: ['phone', 'new_datetime']
    }
  },
  {
    type: 'function',
    name: 'cancel_latest_by_phone',
    description: 'Cancel the caller’s most recent appointment by phone',
    parameters: {
      type: 'object',
      properties: { phone: { type: 'string' } },
      required: ['phone']
    }
  },
  { type: 'function', name: 'get_hours', description: 'Say business hours', parameters: { type: 'object', properties: {} } },
  {
    type: 'function',
    name: 'ask_followup',
    description: 'Ask a short follow-up question',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] }
  }
];

async function execTool(name, args) {
  switch (name) {
    case 'book_appointment': {
      const { name, phone, datetime } = args;
      const { startISO, endISO } = toEventTimes(datetime);
      const g = await gcalCreateEvent({ summary: `Haircut — ${name}`, description: `Booked by phone ${phone}`, startISO, endISO });
      db.prepare('INSERT INTO appointments (customer_name, phone_number, appointment_time, google_event_id) VALUES (?, ?, ?, ?)')
        .run(name, phone, datetime, g.id || null);
      return { speak: `Booked ${name} for ${datetime}.` };
    }
    case 'reschedule_latest_by_phone': {
      const { phone, new_datetime } = args;
      const row = db.prepare('SELECT id, google_event_id FROM appointments WHERE phone_number = ? ORDER BY id DESC LIMIT 1').get(phone);
      if (!row) return { speak: 'I could not find an appointment on that number. Want me to book one instead?' };
      const { startISO, endISO } = toEventTimes(new_datetime);
      if (row.google_event_id) await gcalUpdateEvent({ eventId: row.google_event_id, summary: undefined, description: undefined, startISO, endISO });
      db.prepare('UPDATE appointments SET appointment_time = ? WHERE id = ?').run(new_datetime, row.id);
      return { speak: `All set. I moved it to ${new_datetime}.` };
    }
    case 'cancel_latest_by_phone': {
      const { phone } = args;
      const row = db.prepare('SELECT id, google_event_id FROM appointments WHERE phone_number = ? ORDER BY id DESC LIMIT 1').get(phone);
      if (!row) return { speak: 'I couldn’t find an appointment on that number.' };
      if (row.google_event_id) await gcalDeleteEvent(row.google_event_id);
      db.prepare('DELETE FROM appointments WHERE id = ?').run(row.id);
      return { speak: 'Your appointment has been cancelled.' };
    }
    case 'get_hours': return { speak: HOURS_TEXT };
    case 'ask_followup': return { speak: String(args.question || 'Could you clarify?') };
    default: return { speak: 'Sorry, I did not get that.' };
  }
}

/* ---------- WS bridge (Twilio <-> OpenAI) ---------- */
let wss;
function ensureWSS(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/twilio')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (twilioWS) => {
    console.log('Twilio WS connected');

    const rt = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    let sessionReady = false;
    let greeted = false;
    let audioChunks = 0;

    rt.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.type && !['response.audio.delta'].includes(msg.type)) {
          console.log('Realtime event:', msg.type);
        }

        if (msg.type === 'session.updated') {
          sessionReady = true;

          // Greet *after* session formats are applied
          if (!greeted) {
            greeted = true;
            rt.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                instructions: `Hello, thank you for calling ${BUSINESS_NAME}, how can I help you today?`,
                audio: { voice: 'verse', format: 'g711_ulaw' }
              }
            }));
          }
        }

        if (msg.type === 'response.audio.delta' && msg.audio) {
          audioChunks++;
          twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
        }

        if (msg.type === 'response.function_call') {
          const callId = msg.call_id;
          const fnName = msg.name;
          const args = msg.arguments ? JSON.parse(msg.arguments) : {};
          (async () => {
            const out = await execTool(fnName, args);
            // Return tool output
            rt.send(JSON.stringify({
              type: 'response.function_call_output',
              call_id: callId,
              output: JSON.stringify(out)
            }));
            // Also ensure audio is spoken
            if (out?.speak) {
              rt.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['audio', 'text'],
                  instructions: out.speak,
                  audio: { voice: 'verse', format: 'g711_ulaw' }
                }
              }));
            }
          })().catch(() => {});
        }

        if (msg.type === 'response.done') {
          if (audioChunks) console.log(`Audio chunks sent: ${audioChunks}`);
          audioChunks = 0;
        }

        if (msg.type === 'error') {
          console.error('Realtime ERROR payload:', JSON.stringify(msg, null, 2));
        }
      } catch {}
    });

    rt.on('open', () => {
      console.log('Realtime WS open');
      // Configure audio formats & tools
      rt.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: { type: 'server_vad' },
          voice: 'verse',
          tools: realtimeTools,
          instructions: `
You are a warm, efficient phone receptionist for ${BUSINESS_NAME}.
Talk naturally and concisely. Use the tools to book/reschedule/cancel or state hours.
For bookings: ask day/time first, then full name, then confirm phone if missing.
For rescheduling: ask for new time then move the latest appointment for the caller phone.
Timezone: ${TZ}.
          `.trim()
        }
      }));
    });

    rt.on('close', () => { console.log('Realtime closed'); try { twilioWS.close(); } catch {} });
    rt.on('error', (e) => { console.error('Realtime socket error:', e.message); try { twilioWS.close(); } catch {} });

    twilioWS.on('message', (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        switch (evt.event) {
          case 'start':
            console.log('Twilio start, from:', evt?.start?.customParameters?.from || '');
            break;
          case 'media':
            if (sessionReady && evt.media?.payload) {
              rt.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: evt.media.payload }));
            }
            break;
          case 'stop':
            console.log('Twilio stop'); try { rt.close(); } catch {}
            break;
          default: break;
        }
      } catch {}
    });

    twilioWS.on('close', () => { console.log('Twilio WS closed'); try { rt.close(); } catch {} });
    twilioWS.on('error', () => { try { rt.close(); } catch {} });
  });

  return wss;
}

/* ---------- Twilio webhooks & quick sanity ---------- */
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  console.log('POST /voice -> will stream to', streamUrl);
  const twiml = `
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="from" value="${(req.body?.From || '').replace(/"/g, '')}"/>
    </Stream>
  </Connect>
</Response>`.trim();
  res.type('text/xml').send(twiml);
});

app.get('/voice-say', (_req, res) => {
  const twiml = `
<Response>
  <Say voice="Polly.Matthew-Neural">Polly sanity check. This proves Twilio can speak from your server.</Say>
</Response>`.trim();
  res.type('text/xml').send(twiml);
});

app.get('/health', (_req, res) => res.send('ok'));

/* ---------- Minimal REST (unchanged) ---------- */
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

/* ---------- Boot ---------- */
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log('Server listening on', PORT));
ensureWSS(server);
