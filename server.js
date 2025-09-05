// server.js — minimal Twilio <-> OpenAI Realtime voice bridge (G.711 µ-law)
// No tools, no DB. Just get the AI talking reliably.

import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Health & Twilio entry                                              */
/* ------------------------------------------------------------------ */

app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice', (req, res) => {
  // Twilio will connect its media WS to /twilio below.
  // We include the caller number for logging only.
  const from = (req.body?.From || '').replace(/"/g, '');
  const wssUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wssUrl}">
          <Parameter name="from" value="${from}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

/* ------------------------------------------------------------------ */
/*  HTTP server + WS upgrade                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/* ------------------------------------------------------------------ */
/*  Twilio <-> OpenAI Realtime                                         */
/* ------------------------------------------------------------------ */

wss.on('connection', async (twilioWS, req) => {
  const from =
    new URLSearchParams(req.url.split('?')[1] || '').get('from') || 'unknown';
  console.log('🔌 Twilio stream connected. From:', from);

  // 1) Open the OpenAI Realtime WS
  const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;

  const rt = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // --- State for buffering Twilio audio (20 ms frames) to >= 100 ms ---
  let bufferChunks = [];
  let bytesSinceLastCommit = 0;
  const FRAME_BYTES = 160; // 20ms of 8kHz G.711 µ-law => 160 bytes
  const TARGET_MS = 100; // commit ~100ms
  const TARGET_BYTES = Math.round((TARGET_MS / 20) * FRAME_BYTES); // ~800 bytes
  let openaiReady = false;

  // Periodic flush (safety net). We’ll also flush when threshold reached.
  const flushTimer = setInterval(() => flushAudio(), 100);

  function flushAudio() {
    if (!openaiReady) return;
    if (bytesSinceLastCommit < TARGET_BYTES) return; // not enough audio
    if (bufferChunks.length === 0) return;

    const combined = Buffer.concat(bufferChunks);
    const b64 = combined.toString('base64');

    // Append raw μ-law bytes (base64) then commit
    rt.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: b64,
      })
    );

    rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    // Ask model to produce an audio response for the most recent input.
    rt.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio'],
          conversation: 'default',
          // No instructions here—session already has them.
        },
      })
    );

    bufferChunks = [];
    bytesSinceLastCommit = 0;
  }

  // --- OpenAI Realtime WS events ---

  rt.on('open', () => {
    console.log('🟢 OpenAI WS open');

    // Tell OpenAI we’ll send and expect G.711 µ-law audio.
    // Also set a simple system prompt and greet the caller.
    rt.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          instructions:
            'You are a friendly phone receptionist. Keep replies short and natural.',
        },
      })
    );

    // Say hello immediately so we can hear audio without the caller speaking.
    rt.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio'],
          conversation: 'none',
          instructions: 'Hello! How can I help you today?',
        },
      })
    );

    openaiReady = true;
  });

  rt.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Stream audio from the model back to Twilio
      if (
        msg.type === 'response.output_audio.delta' &&
        msg.audio // base64 µ-law
      ) {
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: msg.audio },
          })
        );
      }

      // Helpful logs
      if (msg.type === 'error') {
        console.error('❌ OpenAI ERROR:', JSON.stringify(msg, null, 2));
      }
    } catch (e) {
      // Some messages are binary; ignore here
    }
  });

  rt.on('close', () => {
    console.log('🔴 OpenAI WS closed');
    try {
      clearInterval(flushTimer);
      twilioWS.close();
    } catch {}
  });

  rt.on('error', (err) => {
    console.error('❌ OpenAI WS error:', err.message || err);
    try {
      clearInterval(flushTimer);
      twilioWS.close();
    } catch {}
  });

  // --- Twilio media frames -> buffer -> OpenAI ---
  twilioWS.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      if (evt.event === 'media' && openaiReady && evt.media?.payload) {
        // Twilio sends base64 G.711 µ-law frames (20ms => 160 bytes)
        const chunk = Buffer.from(evt.media.payload, 'base64');
        bufferChunks.push(chunk);
        bytesSinceLastCommit += chunk.length;

        // If we already collected ~100ms, flush immediately
        if (bytesSinceLastCommit >= TARGET_BYTES) flushAudio();
      }

      if (evt.event === 'stop') {
        // Final flush (if any audio pending)
        flushAudio();
        try {
          rt.close();
        } catch {}
        try {
          twilioWS.close();
        } catch {}
      }
    } catch (e) {
      // ignore parse/other noise
    }
  });

  twilioWS.on('close', () => {
    try {
      clearInterval(flushTimer);
      rt.close();
    } catch {}
  });

  twilioWS.on('error', () => {
    try {
      clearInterval(flushTimer);
      rt.close();
    } catch {}
  });
});

/* ------------------------------------------------------------------ */

server.listen(PORT, () =>
  console.log('✅ Server listening on', PORT, '\nYour service is live 🌐')
);
