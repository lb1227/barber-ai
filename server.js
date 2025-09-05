// server.js — Twilio <-> OpenAI Realtime (g711_ulaw) minimal, talking bot
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const HOST_GREETING = "Hello! Thanks for calling. How can I help you today?";

// --- TwiML entry point: stream call audio to our WS endpoint (/twilio)
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${(req.body?.From || '').replace(/"/g,'')}" />
        </Stream>
      </Connect>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

// health
app.get('/health', (_req, res) => res.send('ok'));

// --- WebSocket upgrade for /twilio
const server = app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log('==>  Your service is live 🌐');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// ---- MAIN BRIDGE: Twilio WS <-> OpenAI Realtime WS
wss.on('connection', async (twilioWS, req) => {
  const from = parseCustomParamFromUrl(req.url, 'from') || '';
  console.log('Twilio stream connected. From:', from || '(unknown)');

  // Connect to OpenAI Realtime
  const rtUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const rt = new (await import('ws')).WebSocket(rtUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // --- state / buffering to avoid "buffer too small" errors
  const FRAMES_PER_COMMIT = 10;     // ~10 * 20ms = 200ms of audio
  let frameCount = 0;
  let openaiReady = false;

  // ---- OpenAI WS handlers
  rt.on('open', () => {
    console.log('OpenAI WS open');

    // IMPORTANT: formats must be strings, not objects
    // Use g711_ulaw both ways to match Twilio media
    rt.send(JSON.stringify({
      type: 'session.update',
      session: {
        // Twilio sends G.711 μ-law 8kHz frames
        input_audio_format: 'g711_ulaw',
        // Ask model to return μ-law audio to us
        output_audio_format: 'g711_ulaw',
        // Optional server-side VAD (helps with turns)
        turn_detection: { type: 'server_vad', silence_duration_ms: 400 }
      }
    }));

    // Send initial greeting as audio
    rt.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],                  // ask for audio response
        instructions: HOST_GREETING,
        audio: { voice: 'alloy' }               // any supported TTS voice
      }
    }));

    openaiReady = true;
  });

  rt.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // Model can stream audio back as "response.output_audio.delta"
      if (data.type === 'response.output_audio.delta' && data.delta) {
        // Twilio expects base64 G.711 μ-law
        twilioWS.send(JSON.stringify({
          event: 'media',
          media: { payload: data.delta }
        }));
      }

      // (Optional) Log helpful things
      if (data.type === 'response.created' || data.type === 'response.done') {
        console.log(`Realtime event: ${data.type}`);
      }

      // Log errors coming from OpenAI—handy in Render logs
      if (data.type === 'error') {
        console.error('Realtime ERROR payload:', JSON.stringify(data, null, 2));
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  rt.on('close', () => {
    console.log('Realtime closed');
    safeClose(twilioWS);
  });
  rt.on('error', (err) => {
    console.error('Realtime error:', err?.message || err);
    safeClose(twilioWS);
  });

  // ---- Twilio WS handlers
  twilioWS.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      switch (evt.event) {
        case 'start':
          console.log('Twilio start, stream:', evt?.start?.streamSid, 'from:', evt?.start?.customParameters?.from || from);
          break;

        case 'media': {
          // Append every 20ms frame to OpenAI input buffer
          if (openaiReady && evt?.media?.payload) {
            rt.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: evt.media.payload          // base64 μ-law frame from Twilio
            }));

            frameCount += 1;
            // Commit roughly every 200ms to avoid "buffer too small"
            if (frameCount >= FRAMES_PER_COMMIT) {
              rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              frameCount = 0;
            }
          }
          break;
        }

        case 'stop':
          // final commit on hangup
          try {
            rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          } catch {}
          safeClose(rt);
          break;

        default:
          // ignore marks, ping, etc
          break;
      }
    } catch {
      // ignore malformed
    }
  });

  twilioWS.on('close', () => {
    console.log('Twilio WS closed');
    safeClose(rt);
  });

  twilioWS.on('error', () => {
    console.log('Twilio WS error');
    safeClose(rt);
  });
});

// ------------- utils
function safeClose(ws) {
  try { ws && ws.readyState === 1 && ws.close(); } catch {}
}

function parseCustomParamFromUrl(url, name) {
  try {
    const q = (url.split('?')[1] || '').split('&');
    for (const kv of q) {
      const [k, v] = kv.split('=');
      if (decodeURIComponent(k) === name) return decodeURIComponent(v || '');
    }
  } catch {}
  return '';
}
