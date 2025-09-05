// server.js — Twilio <-> OpenAI Realtime (minimal, talking “Hello”)
// ESM: "type": "module" in package.json

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* -------------------- Config -------------------- */
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY'); process.exit(1);
}

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
// Twilio <Stream> is μ-law 8k mono. Realtime expects these exact strings:
const TWILIO_FORMAT = 'g711_ulaw';  // <- do not change

/* -------------------- HTTP routes -------------------- */

// Twilio will hit this to start the media stream
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${(req.body?.From || '').replace(/"/g,'')}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// simple health
app.get('/health', (_req, res) => res.send('ok'));

/* -------------------- WS bridge -------------------- */

let wss;
function ensureWSS(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/twilio')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (twilioWS, req) => {
    const from = (() => {
      try {
        const url = new URL(`https://x${req.url}`); // hack for URL parsing
        const p = url.searchParams.get('from');
        return (p || '').replace(/\D/g, '');
      } catch { return ''; }
    })();

    // Connect to OpenAI Realtime
    const rtURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
    const OpenAIWS = new (await import('ws')).WebSocket(rtURL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    // --- State to manage buffering/turn-taking
    let awaitingResponse = false;
    let commitTimer = null;

    // Forward AUDIO FROM OPENAI -> TWILIO
    OpenAIWS.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        // New API: audio chunks arrive as response.output_audio.delta
        if (msg.type === 'response.output_audio.delta' && msg.delta) {
          twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.delta } }));
        }
        if (msg.type === 'response.completed' || msg.type === 'response.cancelled' || msg.type === 'response.error') {
          awaitingResponse = false;
        }
      } catch {}
    });

    OpenAIWS.on('open', () => {
      // Set up the realtime session correctly
      // NOTE:
      //  - input_audio_format: the format coming FROM Twilio (μ-law)
      //  - audio_format: format we want BACK to Twilio (also μ-law)
      //  - voice: must be one of the supported values (e.g. 'verse', 'alloy', ...)
      OpenAIWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format: TWILIO_FORMAT,
          audio_format: TWILIO_FORMAT,
          voice: 'verse',                           // <-- NOT "Matthew"
          instructions: 'You are a friendly receptionist. Keep replies short.',
        }
      }));

      // Speak a short hello immediately so we can confirm audio out
      OpenAIWS.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          instructions: 'Hello! Thanks for calling. How can I help?',
          conversation: 'default'
        }
      }));
    });

    OpenAIWS.on('close', () => { try { twilioWS.close(); } catch {} });
    OpenAIWS.on('error', () => { try { twilioWS.close(); } catch {} });

    // ---- TWILIO -> OPENAI (audio in)
    // We APPEND every frame, and COMMIT on a timer to avoid “buffer too small”
    function startCommitTimer() {
      if (commitTimer) return;
      commitTimer = setInterval(() => {
        // Commit ~every second. Only ask for a response if we’re not already waiting.
        OpenAIWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        if (!awaitingResponse) {
          awaitingResponse = true;
          OpenAIWS.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              conversation: 'default'
            }
          }));
        }
      }, 1000);
    }
    function stopCommitTimer() {
      if (commitTimer) { clearInterval(commitTimer); commitTimer = null; }
    }

    twilioWS.on('message', data => {
      try {
        const evt = JSON.parse(data.toString());

        if (evt.event === 'start') {
          startCommitTimer();
        }

        if (evt.event === 'media' && evt.media?.payload) {
          // Append μ-law payload directly
          OpenAIWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: evt.media.payload
          }));
        }

        if (evt.event === 'stop') {
          // Flush & close both ends
          try {
            OpenAIWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          } catch {}
          stopCommitTimer();
          try { OpenAIWS.close(); } catch {}
          try { twilioWS.close(); } catch {}
        }
      } catch {}
    });

    twilioWS.on('close', () => { stopCommitTimer(); try { OpenAIWS.close(); } catch {} });
    twilioWS.on('error', () => { stopCommitTimer(); try { OpenAIWS.close(); } catch {} });
  });

  return wss;
}

/* -------------------- bootstrap -------------------- */
const server = app.listen(PORT, () => console.log('Server listening on', PORT));
ensureWSS(server);
