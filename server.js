// server.js – Twilio <-> OpenAI Realtime bridge + minimal REST + health
// ESM-only. Node v18+ recommended.

// ---------------------- Imports & Setup ----------------------
import 'dotenv/config';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

const BUSINESS_NAME = 'XYZ barbershop';
const TZ = process.env.TZ || 'America/New_York';

// ---------------------- Utilities ----------------------
function now() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(new Date().toTimeString().split(' ')[0], ...args);
}

// ---------------------- Test Route (Polly-like Say) ----------------------
app.post('/voice-say', (req, res) => {
  // A quick way to verify Twilio can reach your server & you can speak back.
  const text = (req.body.s || `Hello from ${BUSINESS_NAME}. This is a test.`)
    .replace(/[<>]/g, '');
  const twiml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">${text}</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// ---------------------- Twilio entry (TwiML) ----------------------
app.post('/voice', (req, res) => {
  // Twilio will open a bidirectional media WebSocket to /twilio
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
  log('POST /voice -> will stream to', streamUrl);
  res.type('text/xml').send(twiml);
});

// ---------------------- Health ----------------------
app.get('/health', (_req, res) => res.send('ok'));

// ---------------------- WS Upgrade for /twilio ----------------------
const server = app.listen(PORT, () => {
  log('Server listening on', PORT);
  log('==> Available at your primary URL https://barber-ai.onrender.com');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ---------------------- Bridge: Twilio <-> OpenAI Realtime ----------------------
wss.on('connection', async (twilioWS, req) => {
  const fromParam = (() => {
    try {
      const url = new URL(`http://x${req.url}`);
      const p = url.searchParams.get('from');
      return p ? p.replace(/\D/g, '') : '';
    } catch {
      return '';
    }
  })();

  log('Twilio stream connected. From:', fromParam || '(unknown)');

  // Create OpenAI Realtime WS
  const openaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;

  const openaiWS = new WebSocket(openaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // ---- State for batching Twilio audio before commit (>100ms) ----
  const FRAME_MS = 20;               // Twilio media frame is ~20ms @ 8kHz
  const MIN_COMMIT_MS = 120;         // commit when we have >=120ms
  const FRAMES_FOR_COMMIT = Math.ceil(MIN_COMMIT_MS / FRAME_MS); // 6 frames
  const inFrames = [];               // accumulate base64 ulaw chunks from Twilio
  let commitTimer = null;

  function scheduleCommit() {
    if (commitTimer) return;
    commitTimer = setTimeout(() => {
      commitTimer = null;
      if (inFrames.length === 0) return;
      // We already appended each frame as it arrived; now commit once.
      openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      // clear nothing else; we keep appending on every Twilio media event
    }, MIN_COMMIT_MS);
  }

  // ---- OpenAI WebSocket: lifecycle ----
  openaiWS.on('open', () => {
    log('OpenAI WS open');

    // 1) Configure session correctly (correct fields & modalities)
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_format: { type: 'g711_ulaw' },
        output_audio_format: { type: 'g711_ulaw' },
        // A light system prompt
        instructions: `
You are a warm, efficient receptionist for ${BUSINESS_NAME}.
Answer in natural speech. If the caller greets you, greet back and ask how you can help.
If they ask to book, ask for date/time and name. Assume timezone ${TZ}.
        `.trim(),
      },
    };
    openaiWS.send(JSON.stringify(sessionUpdate));

    // 2) Proactively speak first
    const greet = {
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        instructions:
          'Hello, thanks for calling XYZ barbershop. How can I help you today?',
      },
    };
    openaiWS.send(JSON.stringify(greet));
  });

  // ---- Forward OpenAI output audio to Twilio ----
  // Realtime sends output chunks as 'response.output_audio.delta'
  openaiWS.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      // Helpful logging (comment these if too chatty)
      if (data.type === 'response.created') log('Realtime event: response.created');
      if (data.type === 'response.done') log('Realtime event: response.done');
      if (data.type === 'session.updated') log('Realtime event: session.updated');

      if (data.type === 'response.output_audio.delta' && data.delta) {
        // 'delta' is base64 audio using output_audio_format (ulaw)
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: data.delta }, // Twilio expects base64 ulaw
          })
        );
      }

      if (data.type === 'error') {
        log('Realtime ERROR payload:', JSON.stringify(data, null, 2));
      }
    } catch (e) {
      // Silent parse errors – leave stream running.
    }
  });

  openaiWS.on('close', () => {
    log('OpenAI WS closed');
    safeClose(twilioWS);
  });

  openaiWS.on('error', (err) => {
    log('OpenAI WS error:', err?.message || err);
    safeClose(twilioWS);
  });

  // ---- Twilio media handling: append > commit (>100ms) ----
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.event) {
        case 'start': {
          log('Twilio start, stream:', msg?.start?.streamSid, 'from:', fromParam);
          break;
        }
        case 'media': {
          // Twilio media.payload is base64 g711_ulaw @ 8kHz, 20ms per frame
          // Append to OpenAI's input buffer:
          const payload = msg.media.payload; // base64
          inFrames.push(payload);
          openaiWS.send(
            JSON.stringify({ type: 'input_audio_buffer.append', audio: payload })
          );

          // commit after we collect ~6 frames (~120ms)
          if (inFrames.length >= FRAMES_FOR_COMMIT) {
            openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            inFrames.length = 0; // reset for next batch
          } else {
            scheduleCommit(); // timer-based commit as a backstop
          }
          break;
        }
        case 'mark': {
          // not used
          break;
        }
        case 'stop': {
          log('Twilio stop');
          // final commit if any buffered frames remain
          if (inFrames.length > 0) {
            openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            inFrames.length = 0;
          }
          safeClose(openaiWS);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  twilioWS.on('close', () => {
    log('Twilio WS closed');
    safeClose(openaiWS);
  });

  twilioWS.on('error', () => {
    safeClose(openaiWS);
  });
});

// ---------------------- Helpers ----------------------
function safeClose(ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch {}
}
