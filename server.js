// server.js — Twilio <-> OpenAI Realtime bridge (fixed)
// ESM syntax, Node 18+
// ----------------------------------------------------

import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- config ----
const PORT = process.env.PORT || 3000;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const POLLY_VOICE = process.env.POLLY_VOICE || 'Matthew'; // used only in fallback

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

/* ------------------------------------------
   HEALTH + simple “say” endpoint for testing
-------------------------------------------*/
app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice-say', (req, res) => {
  const speak = req.body.speak || 'Your service is live.';
  const twiml = `
    <Response>
      <Say voice="Polly.${POLLY_VOICE}-Neural">${speak}</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

/* ----------------------------------------------------
   Twilio entry: connect media stream to our ws endpoint
-----------------------------------------------------*/
app.post('/voice', (req, res) => {
  const wsUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl}">
          <Parameter name="from" value="${(req.body.From || '').replace(/"/g, '')}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

/* ----------------------------------------------------
   WebSocket bridge: Twilio <-> OpenAI Realtime
-----------------------------------------------------*/
const server = app.listen(PORT, () =>
  console.log('Server listening on', PORT)
);

const wss = new WebSocketServer({ noServer: true });

// upgrade just for /twilio
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (twilioWS, req) => {
  const tag = Math.random().toString(36).slice(2, 7);

  function log(...a) {
    console.log(tag, ...a);
  }

  // OpenAI Realtime WS
  const oaUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;

  const oaWS = new WebSocket(oaUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let sessionReady = false;

  // Buffer for Twilio frames (each ~20ms)
  const FRAME_MS = 20;
  const MIN_COMMIT_MS = 120; // >= 100ms required by OpenAI; we use 120ms
  let bufferedMs = 0;
  let pendingFrames = []; // base64 μ-law chunks
  let twilioOpen = true;

  // Helper: commit the buffered audio to OpenAI and ask for a reply
  function commitIfEnough(reason = 'timer') {
    if (!sessionReady) return;
    if (pendingFrames.length === 0) return;
    if (bufferedMs < MIN_COMMIT_MS && reason !== 'final') return;

    // Concatenate base64 chunks into a single base64 string
    const audioB64 = pendingFrames.join('');
    pendingFrames = [];
    bufferedMs = 0;

    // 1) Send the audio
    oaWS.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: audioB64, // μ-law base64 from Twilio
      })
    );

    // 2) Commit the buffer
    oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    // 3) Ask the model to respond with audio
    oaWS.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'], // CORRECT shape
          // instructions optional; conversation memory will drive turn-taking
          audio: { voice: 'verse' }, // CORRECT nesting (no “response.audio”)
        },
      })
    );
  }

  // ---------- OpenAI WS handlers ----------
  oaWS.on('open', () => {
    log('OpenAI WS open');

    // Tell OpenAI we will stream μ-law from Twilio
    oaWS.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          // THIS is the key that fixes “invalid_type”:
          input_audio_format: 'g711_ulaw',
          // optional: lower latency
          turn_detection: { type: 'server_vad' },
          instructions:
            'You are a concise, friendly phone receptionist. Speak clearly.',
        },
      })
    );

    // Say hello immediately so you hear something as soon as the call connects
    oaWS.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'],
          instructions: 'Hello, thanks for calling. How can I help you today?',
          audio: { voice: 'verse' },
        },
      })
    );

    sessionReady = true;
  });

  // Forward audio deltas from OpenAI to Twilio
  oaWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // When the model sends audio, forward it to Twilio
      if (msg.type === 'response.output_audio.delta' && msg.audio) {
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: msg.audio }, // base64 μ-law
          })
        );
      }

      // Useful logging for debugging
      if (msg.type === 'error') {
        log('OpenAI ERROR:', msg);
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  oaWS.on('close', () => {
    log('OpenAI WS closed');
    if (twilioOpen) twilioWS.close();
  });

  oaWS.on('error', (err) => {
    log('OpenAI WS error', err?.message || err);
    if (twilioOpen) twilioWS.close();
  });

  // ---------- Twilio WS handlers ----------
  let framesSinceCommit = 0;

  const commitTimer = setInterval(() => {
    // periodic commit to keep the pipeline flowing
    commitIfEnough('timer');
  }, 200); // 200ms cadence

  twilioWS.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      switch (evt.event) {
        case 'start': {
          log('Twilio stream connected. From:', evt?.start?.customParameters?.from || '(unknown)');
          break;
        }
        case 'media': {
          // Twilio media payload is base64 μ-law audio (8kHz)
          const chunk = evt?.media?.payload;
          if (chunk) {
            pendingFrames.push(chunk);
            framesSinceCommit += 1;
            bufferedMs += FRAME_MS;
            // extra safety: if caller is speaking rapidly, commit in chunks
            if (bufferedMs >= MIN_COMMIT_MS && framesSinceCommit >= 6) {
              commitIfEnough('threshold');
              framesSinceCommit = 0;
            }
          }
          break;
        }
        case 'mark': {
          // not used
          break;
        }
        case 'stop': {
          // Final flush
          commitIfEnough('final');
          break;
        }
        default:
          break;
      }
    } catch (_) {
      /* ignore */
    }
  });

  twilioWS.on('close', () => {
    twilioOpen = false;
    clearInterval(commitTimer);
    try { oaWS.close(); } catch {}
  });

  twilioWS.on('error', () => {
    twilioOpen = false;
    clearInterval(commitTimer);
    try { oaWS.close(); } catch {}
  });
});
