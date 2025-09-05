// server.js — Twilio <-> OpenAI Realtime (G.711 µ-law) + simple greeting
import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws'; // ESM import ONLY
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* -------------------- CONFIG -------------------- */
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

const BUSINESS_NAME = 'XYZ Barbershop';
const VOICE_NAME = 'verse'; // hint for model voice

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* -------------------- BASIC HEALTH -------------------- */
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* -------------------- TWILIO ENTRY -------------------- */
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${(req.body.From || '').replace(/"/g, '')}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

/* -------------------- WEBSOCKET BRIDGE -------------------- */
const wss = new WebSocketServer({ noServer: true });

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

  let pendingFrames = [];
  const FRAMES_PER_COMMIT = 6; // 6 * 20ms ≈ 120ms (>=100ms)
  let openaiWS = null;
  let openaiReady = false;
  let closed = false;

  const openOpenAI = () =>
    new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
        REALTIME_MODEL
      )}`;

      // ✅ ESM class from 'ws'
      openaiWS = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      openaiWS.on('open', () => {
        console.log('Realtime WS open');
        openaiReady = true;

        // Twilio sends 8kHz µ-law (G.711 u-law)
        openaiWS.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              input_audio_format: 'g711_ulaw',
              voice: VOICE_NAME,
              instructions: `You are a friendly phone receptionist for ${BUSINESS_NAME}. Be brief, natural and helpful.`,
            },
          })
        );

        // Immediate greeting
        openaiWS.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio'],
              instructions: `Hello! Thanks for calling ${BUSINESS_NAME}. How can I help you today?`,
            },
          })
        );

        resolve();
      });

      openaiWS.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());

          // ✅ Correct event name for audio chunks
          if (msg.type === 'response.output_audio.delta' && msg.delta) {
            const frame = {
              event: 'media',
              media: { payload: msg.delta }, // base64 μ-law 8kHz
            };
            try { twilioWS.send(JSON.stringify(frame)); } catch (_) {}
          }

          if (msg.type === 'error') {
            console.error('Realtime ERROR payload:', JSON.stringify(msg, null, 2));
          }
        } catch (_) {}
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

  // Append & commit >=100ms chunks to OpenAI
  const appendAndMaybeCommit = b64ulaw => {
    pendingFrames.push(b64ulaw);
    if (pendingFrames.length >= FRAMES_PER_COMMIT && openaiReady) {
      const joined = pendingFrames.join('');
      pendingFrames = [];

      try {
        openaiWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: joined
        }));
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        openaiWS.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio'] }
        }));
      } catch (e) {
        console.error('append/commit error:', e?.message || e);
      }
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
        if (evt.media && evt.media.payload) {
          appendAndMaybeCommit(evt.media.payload);
        }
        break;

      case 'stop':
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
