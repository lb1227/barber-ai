// server.js — Minimal working Realtime voice (speak-only) + Calendar/DB + strong error logs
import 'dotenv/config';
import express from 'express';
import db from './database.js';
import { WebSocket, WebSocketServer } from 'ws';
import { google } from 'googleapis';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BUSINESS_NAME = 'XYZ barbershop';
const HOURS_TEXT = 'We are open Tuesday to Saturday, 8 AM to 8 PM.';
const TZ = process.env.TZ || 'America/New_York';
const POLLY_VOICE = 'Polly.Matthew-Neural';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// ---- DB migration (safe)
try { db.prepare('ALTER TABLE appointments ADD COLUMN google_event_id TEXT').run(); } catch {}

// ---- Google Calendar helpers
function makeGAuth() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}
const calendarIdFromEnv = () =>
  process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

async function gcalCreateEvent({ summary, description, startISO, endISO }) {
  const calendar = makeGAuth();
  if (!calendar) return { id: null, ok: false, error: 'gcal not configured' };
  const res = await calendar.events.insert({
    calendarId: calendarIdFromEnv(),
    requestBody: {
      summary, description,
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ }
    }
  });
  return { id: res.data.id || null, ok: true };
}
async function gcalUpdateEvent({ eventId, startISO, endISO }) {
  const calendar = makeGAuth();
  if (!calendar || !eventId) return { ok: false };
  await calendar.events.patch({
    calendarId: calendarIdFromEnv(),
    eventId,
    requestBody: {
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ }
    }
  });
  return { ok: true };
}
async function gcalDeleteEvent(eventId) {
  const calendar = makeGAuth();
  if (!calendar || !eventId) return { ok: false };
  await calendar.events.delete({ calendarId: calendarIdFromEnv(), eventId });
  return { ok: true };
}

// ---- time helpers
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

// ---- Realtime bridge (speak-only to verify audio)
/* ─────────── Realtime streaming bridge (fixed formats + modalities) ─────────── */
let wss;
function ensureWSS(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

  const INPUT_FORMAT = 'g711_ulaw';   // Twilio sends μ-law
  const OUTPUT_FORMAT = 'g711_ulaw';  // Send μ-law back to Twilio

  // Upgrade HTTP -> WS only for /twilio
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/twilio')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (twilioWS, req) => {
    const rtURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
    const RTWS = (await import('ws')).WebSocket;

    const rt = new RTWS(rtURL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let callerPhone = '';
    let sessionReady = false;

    // Helper: log JSON safely
    const safeLog = (prefix, obj) => {
      try { console.log(prefix, JSON.stringify(obj, null, 2)); }
      catch { console.log(prefix, obj); }
    };

    // From OpenAI → to Twilio
    rt.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        // Audio stream out to Twilio
        if (data.type === 'response.audio.delta' && data.audio) {
          twilioWS.send(JSON.stringify({ event: 'media', media: { payload: data.audio } }));
        }

        // Tool call from model
        if (data.type === 'response.function_call') {
          (async () => {
            const { name, arguments: argStr, call_id } = data;
            const args = argStr ? JSON.parse(argStr) : {};
            if (!args.phone && callerPhone) args.phone = callerPhone;

            const result = await execTool(name, args, {});
            rt.send(JSON.stringify({
              type: 'response.function_call_output',
              call_id,
              output: JSON.stringify(result)
            }));
          })();
        }

        // Errors from the Realtime service
        if (data.type === 'error' || data.error) {
          safeLog('Realtime ERROR payload:', data);
        }
      } catch (e) {
        console.log('Realtime parse error:', e?.message || e);
      }
    });

    rt.on('open', () => {
      // Configure the Realtime session once (formats + tools + instructions)
      rt.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions: `
You are a warm, efficient phone receptionist for ${BUSINESS_NAME}.
Use tools to book, reschedule, or cancel. Default timezone: ${TZ}.
Speak naturally and concisely. Always confirm the requested time/date and name.
`,
          // CRITICAL: these must be strings, not objects
          input_audio_format: INPUT_FORMAT,
          output_audio_format: OUTPUT_FORMAT,

          // Put tools on the session
          tools: tools
        }
      }));

      // Kick off a spoken greeting (must include both audio and text)
      rt.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          instructions: 'Hello, thank you for calling XYZ barbershop, how can I help you today?'
        }
      }));

      sessionReady = true;
    });

    rt.on('close', () => { try { twilioWS.close(); } catch {} });
    rt.on('error', (err) => {
      console.log('Realtime ws error:', err?.message || err);
      try { twilioWS.close(); } catch {}
    });

    // From Twilio → to OpenAI
    twilioWS.on('message', (raw) => {
      try {
        const evt = JSON.parse(raw.toString());

        // Twilio stream start: capture caller number
        if (evt.event === 'start') {
          callerPhone = (evt?.start?.customParameters?.from || '').replace(/\D/g, '');
          return;
        }

        // Caller audio frames → append to input buffer
        if (evt.event === 'media' && sessionReady) {
          rt.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: evt.media.payload  // base64 μ-law
          }));
          return;
        }

        // Twilio ended the stream
        if (evt.event === 'stop') {
          // Finalize any buffered audio
          if (sessionReady) {
            rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          }
          try { rt.close(); } catch {}
          try { twilioWS.close(); } catch {}
          return;
        }
      } catch (e) {
        console.log('Twilio WS parse error:', e?.message || e);
      }
    });

    twilioWS.on('close', () => { try { rt.close(); } catch {} });
    twilioWS.on('error', () => { try { rt.close(); } catch {} });
  });

  return wss;
}


// ---- Twilio webhook
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  console.log('POST /voice → will stream to', streamUrl);
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}"/>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// Quick audio test (you used this already)
app.post('/voice-say', (_req, res) => {
  const twiml = `
    <Response>
      <Say voice="${POLLY_VOICE}">Quick audio test. If you hear this, Twilio playback is working.</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// ---- REST API (unchanged)
app.post('/make-appointment', (req, res) => {
  const { customer_name, phone_number, appointment_time } = req.body || {};
  if (!customer_name || !phone_number || !appointment_time)
    return res.json({ success: false, error: 'Missing fields. Required: customer_name, phone_number, appointment_time' });
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

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log('Server listening on', PORT));
ensureWSS(server);
