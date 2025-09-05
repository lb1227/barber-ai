// server.js — Twilio <-> OpenAI Realtime (minimal, robust logging)
// Goal: get audio out, and print FULL errors so we can see the exact bad field.

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { WebSocketServer } from 'ws';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

// --- helpers ---
const SAMPLE_RATE = 8000;      // μ-law sample rate
const ULawSilenceByte = 0xFF;  // silence byte for μ-law
const FRAME_MS = 20;           // small chunk to keep Twilio alive

function b64Silence(ms = FRAME_MS) {
  const bytes = Buffer.alloc((SAMPLE_RATE / 1000) * ms, ULawSilenceByte);
  return bytes.toString('base64');
}
const now = () => new Date().toISOString();

function makeQueuedSender(ws) {
  let open = false;
  const q = [];
  ws.on('open', () => {
    open = true;
    while (q.length) ws.send(q.shift());
  });
  return (payload) => {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (open) ws.send(s);
    else q.push(s);
  };
}

// --- simple test endpoint ---
app.post('/voice-say', (_req, res) => {
  const twiml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">Webhook test. Your TwiML URL is working.</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// --- main Twilio voice entry (streams to our WS) ---
app.post('/voice', (req, res) => {
  const url = `wss://${req.headers.host}/twilio`;
  const from = (req.body?.From || '').replace(/"/g, '');
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${url}">
          <Parameter name="from" value="${from}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

app.get('/health', (_req, res) => res.send('ok'));

// --- WS bridge ---
const wss = new WebSocketServer({ noServer: true });
const server = app.listen(PORT, () => console.log(`[${now()}] Server listening on ${PORT}`));
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', async (twilioWS) => {
  console.log(`[${now()}] Twilio WS open`);

  // keep Twilio alive while we connect to OpenAI
  try { for (let i = 0; i < 3; i++) twilioWS.send(JSON.stringify({ event: 'media', media: { payload: b64Silence() } })); } catch {}

  // connect to OpenAI Realtime
  const rt = new (await import('ws')).WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );
  const sendRT = makeQueuedSender(rt);

  let sawAudioDelta = false;

  rt.on('open', () => {
    console.log(`[${now()}] Realtime WS open`);

    // 🔑 Minimal, known-good session update: only STRINGS for formats + a voice
    sendRT({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'verse'
        // If this succeeds, we can add server VAD later.
        // turn_detection: { type: 'server_vad', silence_duration_ms: 700, threshold: 0.5 }
      }
    });

    // Guaranteed hello (modalities must be ['audio','text'] for audio)
    sendRT({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        audio: { format: 'g711_ulaw', voice: 'verse' },
        instructions: 'Hello, thanks for calling the barbershop. How can I help you today?'
      }
    });
  });

  // 🔎 LOG EVERYTHING (full JSON for errors so we can see the exact field)
  rt.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) { return console.error(`[${now()}] Realtime parse error:`, e); }

    if (msg.type === 'error') {
      console.error(`[${now()}] Realtime ERROR: ${JSON.stringify(msg, null, 2)}`);
      return;
    }

    // helpful tracing
    if (msg.type && !msg.type.includes('audio.delta')) {
      console.log(`[${now()}] Realtime msg: ${msg.type}`);
    }

    // audio to Twilio
    if (
      (msg.type === 'response.audio.delta' && msg.audio) ||
      (msg.type === 'response.output_audio.delta' && msg.audio)
    ) {
      sawAudioDelta = true;
      try {
        twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
      } catch (e) {
        console.error(`[${now()}] Twilio send error:`, e?.message || e);
      }
    }

    if (msg.type === 'response.created') sawAudioDelta = false;
    if (msg.type === 'response.done' && !sawAudioDelta) {
      console.warn(`[${now()}] response.done but no audio deltas this turn.`);
    }
  });

  rt.on('close', (code, reason) => {
    console.error(`[${now()}] Realtime closed. code=${code}, reason=${reason?.toString?.() || ''}`);
    // keep Twilio alive just a moment so call isn’t hard-dropped
    try { for (let i = 0; i < 40; i++) twilioWS.send(JSON.stringify({ event: 'media', media: { payload: b64Silence() } })); } catch {}
    try { twilioWS.close(); } catch {}
  });

  rt.on('error', (e) => console.error(`[${now()}] Realtime WS error:`, e?.message || e));

  // Twilio -> OpenAI
  twilioWS.on('message', (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch (e) { return; }

    if (evt.event === 'media' && evt.media?.payload) {
      // Just forward — we’ll add VAD later once session.update is accepted
      sendRT({ type: 'input_audio_buffer.append', audio: evt.media.payload });
    } else if (evt.event === 'stop') {
      console.log(`[${now()}] Twilio stop`);
      try { sendRT({ type: 'input_audio_buffer.commit' }); } catch {}
      try { rt.close(); } catch {}
      try { twilioWS.close(); } catch {}
    } else if (evt.event === 'start') {
      console.log(`[${now()}] Twilio start, from:`, evt?.start?.customParameters?.from);
    }
  });

  twilioWS.on('close', () => { try { rt.close(); } catch {} });
  twilioWS.on('error', () => { try { rt.close(); } catch {} });
});
