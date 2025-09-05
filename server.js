// server.js — Twilio <-> OpenAI Realtime (G.711 µ-law) + simple greeting
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* -------------------- CONFIG -------------------- */
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

// simple name/voice; the model generates the speech we stream back to Twilio
const BUSINESS_NAME = 'XYZ Barbershop';
const VOICE_NAME = 'verse'; // model voice hint

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* -------------------- BASIC HEALTH -------------------- */
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* -------------------- TWILIO ENTRY -------------------- */
/**
 * Twilio will call this URL. We respond with TwiML that connects the
 * call to our websocket /twilio for bi-directional audio.
 */
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
  `.trim();
  res.type('text/xml').send(twiml);
});

/* -------------------- WEBSOCKET BRIDGE -------------------- */
const wss = new WebSocketServer({ noServer: true });

/**
 * Upgrade HTTP -> WS only for /twilio
 */
const server = app.listen(PORT, () => {
  console.log('Server listening on', PORT);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

/**
 * Twilio WS <-> OpenAI WS bridge
 */
wss.on('connection', async (twilioWS, req) => {
  const caller = (() => {
    try {
      const u = new URL(`http://x${req.url}`); // fake host to parse query
      return (u.searchParams.get('from') || '').replace(/\D/g, '');
    } catch (_) { return ''; }
  })();

  console.log('Twilio stream connected. From:', caller);

  // Buffer of incoming Twilio media frames (base64 µ-law 8kHz)
  let pendingFrames = [];
  const FRAMES_PER_COMMIT = 6; // 6 * 20ms ≈ 120ms (>=100ms required)
  let openaiWS = null;
  let openaiReady = false;
  let closed = false;

  const openOpenAI = () =>
    new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;

      openaiWS = new (require('ws'))(url, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      openaiWS.on('open', () => {
        console.log('Realtime WS open');
        openaiReady = true;

        // Tell the session what comes in: Twilio sends 8kHz µ-law
        openaiWS.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              input_audio_format: 'g711_ulaw',  // MUST be a string
              // optionally tell output format (we’ll just forward deltas as-is)
              // output_audio_format: 'g711_ulaw',
              voice: VOICE_NAME,
              instructions: `You are a friendly phone receptionist for ${BUSINESS_NAME}. Be brief, natural and helpful.`
            },
          })
        );

        // Say hello immediately so caller hears something right away
        openaiWS.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio'], // we only need audio
              instructions: `Hello! Thanks for calling ${BUSINESS_NAME}. How can I help you today?`,
            },
          })
        );

        resolve();
      });

      openaiWS.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());

          // OpenAI -> audio back to Twilio
          if (msg.type === 'response.output_audio.delta' && msg.delta) {
            // msg.delta is base64 µ-law audio chunk (8kHz)
            const frame = {
              event: 'media',
              media: { payload: msg.delta },
            };
            try { twilioWS.send(JSON.stringify(frame)); } catch (_) {}
          }

          if (msg.type === 'response.completed') {
            // If we wanted, we could request another response, etc.
            // console.log('response completed');
          }

          if (msg.type === 'error') {
            console.error('Realtime ERROR payload:', JSON.stringify(msg, null, 2));
          }
        } catch (e) {
          // ignore parse errors
        }
      });

      openaiWS.on('close', () => {
        console.log('Realtime closed');
        openaiReady = false;
        if (!closed) {
          try { twilioWS.close(); } catch (_) {}
        }
      });

      openaiWS.on('error', err => {
        console.error('Realtime socket error:', err?.message || err);
        reject(err);
      });
    });

  try {
    await openOpenAI();
  } catch (e) {
    console.error('OpenAI WS failed to open:', e?.message || e);
    try { twilioWS.close(); } catch (_) {}
    return;
  }

  // Helper: append frames and commit to OpenAI in ≥100ms chunks
  const appendAndMaybeCommit = b64ulaw => {
    pendingFrames.push(b64ulaw);
    if (pendingFrames.length >= FRAMES_PER_COMMIT && openaiReady) {
      // Join frames into one large base64 (still μ-law)
      const joined = pendingFrames.join('');
      pendingFrames = [];

      // Append then commit
      try {
        openaiWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: joined
        }));
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      } catch (e) {
        console.error('append/commit error:', e?.message || e);
      }

      // Ask the model to speak a response for whatever was heard
      try {
        openaiWS.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio'] } // let model decide what to say next
        }));
      } catch (_) {}
    }
  };

  /* -------- Twilio stream events -------- */
  twilioWS.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch (_) { return; }

    switch (evt.event) {
      case 'start':
        console.log('Twilio start, from:', evt?.start?.customParameters?.from);
        break;

      case 'media':
        // Each payload is base64 μ-law @ 8kHz, ~20ms per frame.
        if (evt.media && evt.media.payload) {
          appendAndMaybeCommit(evt.media.payload);
        }
        break;

      case 'stop':
        // Commit anything left and close cleanly
        if (pendingFrames.length && openaiReady) {
          try {
            openaiWS.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: pendingFrames.join('')
            }));
            openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            openaiWS.send(JSON.stringify({
              type: 'response.create',
              response: { modalities: ['audio'] }
            }));
          } catch (_) {}
          pendingFrames = [];
        }
        try { openaiWS.close(); } catch (_) {}
        try { twilioWS.close(); } catch (_) {}
        break;

      default:
        // ignore marks, dtmf, etc.
        break;
    }
  });

  twilioWS.on('close', () => {
    closed = true;
    try { openaiWS && openaiWS.close(); } catch (_) {}
  });

  twilioWS.on('error', () => {
    closed = true;
    try { openaiWS && openaiWS.close(); } catch (_) {}
  });
});
