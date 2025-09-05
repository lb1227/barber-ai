// server.js (ESM)
// Minimal, stable Twilio <-> OpenAI Realtime bridge (µ-law pass-through, hello greeting, bidirectional)

// ===== Imports =====
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

// ===== Env =====
const PORT = process.env.PORT || 10000;
const HOST = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

// ===== App =====
const app = express();
app.use(express.json());

// Health
app.get('/health', (_, res) => res.status(200).send('ok'));

// TwiML (IMPORTANT: bidirectional audio enabled via track="both_tracks")
app.post('/voice', (req, res) => {
  const base =
    HOST ||
    (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
      ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
      : `https://${req.headers.host}`);

  const streamUrl = `${base.replace(/^http/, 'ws')}/twilio`;

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}" track="both_tracks"/>
      </Connect>
    </Response>
  `.trim();

  res.type('text/xml').send(twiml);
});

// Friendly landing
app.get('/', (req, res) => {
  const base =
    HOST ||
    (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
      ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
      : `https://${req.headers.host}`);
  res.type('text/plain').send(
    [
      'Your service is live 🎉',
      `Available at your primary URL ${base}`,
      'POST /voice -> streams to wss://.../twilio (bidirectional)',
    ].join('\n')
  );
});

// ===== HTTP + WS =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Helpers
const log = (id, msg) => console.log(`${new Date().toISOString()} ${id} ${msg}`);
const safeSendJSON = (ws, obj) => {
  try {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
};

// Build an append event for µ-law frames coming from Twilio
const makeAppendEventUlaw = (b64) => ({
  type: 'input_audio_buffer.append',
  audio: { data: b64, format: 'g711_ulaw' },
});

// Per-call bridge
wss.on('connection', (twilioWS) => {
  const id = crypto.randomBytes(3).toString('hex');
  log(id, 'Twilio WS connected.');

  // OpenAI realtime WS
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  let streamSid = null;

  // Buffer incoming 20ms Twilio frames and commit after >=100ms
  let frameBuffer = [];
  let framesSinceCommit = 0;
  const COMMIT_EVERY = 5; // 5 * 20ms = 100ms

  const commitIfReady = (force = false) => {
    if (!force && framesSinceCommit < COMMIT_EVERY) return;
    if (frameBuffer.length) {
      for (const ev of frameBuffer) safeSendJSON(oaWS, ev);
      frameBuffer = [];
    }
    safeSendJSON(oaWS, { type: 'input_audio_buffer.commit' });
    framesSinceCommit = 0;
  };

  // ---- OpenAI events ----
  oaWS.on('open', () => {
    log(id, 'OpenAI WS open');

    // Tell OpenAI our incoming audio format
    safeSendJSON(oaWS, {
      type: 'session.update',
      session: { input_audio_format: 'g711_ulaw' },
    });

    // Send a simple "Hello" as an audio response (g711_ulaw) so you can hear something immediately
    safeSendJSON(oaWS, {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: 'Say "Hello".',
        audio: { voice: 'alloy', format: 'g711_ulaw' },
      },
    });
  });

  oaWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Log key events for debugging
      if (msg.type === 'response.created') log(id, 'OpenAI response.created');
      if (msg.type === 'response.completed') log(id, 'OpenAI response.completed');
      if (msg.type === 'response.output_text.delta' && msg.delta) {
        log(id, `TXT: ${msg.delta}`);
      }

      // Forward audio deltas to Twilio (now allowed because track="both_tracks")
      if (msg.type === 'response.output_audio.delta' && msg.delta && streamSid) {
        safeSendJSON(twilioWS, {
          event: 'media',
          streamSid,
          media: { payload: msg.delta }, // base64 g711_ulaw
        });
      }
    } catch {}
  });

  oaWS.on('close', () => {
    log(id, 'OpenAI WS closed');
    try { twilioWS.close(); } catch {}
  });

  oaWS.on('error', (err) => log(id, `OpenAI WS ERROR: ${err?.message || err}`));

  // ---- Twilio events ----
  twilioWS.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch { return; }

    switch (m.event) {
      case 'start':
        streamSid = m.start?.streamSid;
        log(id, `Twilio start, streamSid: ${streamSid}`);
        break;

      case 'media': {
        const b64 = m.media?.payload;
        if (b64 && oaWS.readyState === WebSocket.OPEN) {
          frameBuffer.push(makeAppendEventUlaw(b64));
          framesSinceCommit += 1;
          commitIfReady(false);
        }
        break;
      }

      case 'stop':
        commitIfReady(true);
        log(id, 'Twilio stop');
        break;

      default:
        break;
    }
  });

  twilioWS.on('close', () => {
    log(id, 'Twilio WS closed');
    try {
      commitIfReady(true);
      oaWS.close();
    } catch {}
  });

  twilioWS.on('error', (err) => log(id, `Twilio WS ERROR: ${err?.message || err}`));

  // Keep both sockets alive
  const ping = setInterval(() => {
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.ping(); } catch {}
    try { if (oaWS.readyState === WebSocket.OPEN) oaWS.ping(); } catch {}
  }, 25000);
  twilioWS.on('close', () => clearInterval(ping));
  oaWS.on('close', () => clearInterval(ping));
});

// ===== Start =====
server.listen(PORT, () => {
  const url =
    HOST ||
    (process.env.RENDER ? `https://${process.env.RENDER_EXTERNAL_URL}` : '');
  console.log('////////////////////////////////////////////////////////');
  console.log(`Server listening on ${PORT}`);
  console.log('Your service is live 🎉');
  if (url) {
    console.log('////////////////////////////////////////////////////////');
    console.log(`Available at your primary URL ${url}`);
  }
  console.log('////////////////////////////////////////////////////////');
});
