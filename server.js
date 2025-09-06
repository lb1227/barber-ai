/**
 * BarberAI Twilio <-> OpenAI Realtime bridge
 * - Accepts Twilio <Stream> (G.711 µ-law, 8 kHz, mono)
 * - Streams caller audio to OpenAI Realtime
 * - Streams OpenAI TTS audio back to caller
 * - Robust logging so Render logs show every step
 *
 * ENV REQUIRED:
 *   OPENAI_API_KEY=sk-...
 *   MODEL=gpt-4o-realtime-preview-2024-12-17  (or your realtime-capable model)
 *   PORT=10000                                 (Render will inject this)
 */

// Optional dotenv (won't crash if missing)
try { require('dotenv').config(); } catch (_) {}

const http = require('http');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o-realtime-preview-2024-12-17';

// ------------------------------
// Basic health + Twilio status logs
// ------------------------------
app.get('/', (_, res) => res.status(200).send('OK'));
app.post('/twilio-status', (req, res) => {
  try {
    console.log('Twilio status callback body:', JSON.stringify(req.body));
  } catch (_) {}
  res.sendStatus(200);
});

// ------------------------------
// HTTP server + “upgrade” logger (critical for diagnosing)
// ------------------------------
const server = http.createServer(app);

// Always prints when Twilio attempts to connect
server.on('upgrade', (req, socket, _head) => {
  console.log('HTTP UPGRADE attempt:', req.url, {
    host: req.headers.host,
    ua: req.headers['user-agent'],
    proto: req.headers['sec-websocket-protocol'] || null,
  });
});

// ------------------------------
// WebSocket server for Twilio
// ------------------------------
const wss = new WebSocket.Server({ noServer: true });

// Only accept upgrades for /twilio
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/twilio') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

// ------------------------------
// Twilio <-> OpenAI Realtime bridge
// ------------------------------
wss.on('connection', (twilioWS, req) => {
  console.log('WS CONNECTED on /twilio from:', req.socket.remoteAddress);

  let streamSid = null;
  let openaiWS = null;
  let openaiReady = false;

  // Buffer caller audio (μ-law 8 kHz mono)
  const frameBuffers = [];
  let bufferedMs = 0;

  // Flush caller audio to OpenAI every >= 140ms
  const FLUSH_MS = 140;

  const flushToOpenAI = () => {
    if (!openaiReady) return;
    if (frameBuffers.length === 0) return;

    const pcmu = Buffer.concat(frameBuffers.splice(0));
    bufferedMs = 0;

    try {
      // Append
      openaiWS.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcmu.toString('base64'),
        })
      );
      // Commit (frame must be >= ~100ms)
      openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      // Ask for a response (audio+text)
      openaiWS.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            instructions:
              "You are BarberAI, a friendly scheduling assistant for a barbershop. Keep replies short. If the caller says 'hello', greet them and ask how you can help.",
            conversation: 'auto',
          },
        })
      );
    } catch (err) {
      console.error('OpenAI send error during flush:', err.message);
    }
  };

  const flushTimer = setInterval(flushToOpenAI, FLUSH_MS);

  // 1) Connect to OpenAI Realtime
  const connectOpenAI = () => {
    if (!OPENAI_API_KEY) {
      console.error('Missing OPENAI_API_KEY env.');
      return twilioWS.close();
    }

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      MODEL
    )}`;

    openaiWS = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openaiWS.on('open', () => {
      console.log('[OpenAI] WS open');

      // Match Twilio formats and pick a stable voice
      openaiWS.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            voice: 'alloy',
          },
        })
      );

      openaiReady = true;

      // Warm-up so caller hears something even if they’re silent
      openaiWS.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            instructions:
              "Greet the caller briefly and ask how you can help with booking a haircut.",
            conversation: 'auto',
          },
        })
      );
    });

    openaiWS.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'response.output_audio.delta') {
          // μ-law 8kHz base64 chunk -> Twilio
          if (twilioWS.readyState === WebSocket.OPEN && streamSid) {
            const payload = msg.delta;
            const frame = {
              event: 'media',
              streamSid,
              media: { payload },
              track: 'outbound', // TwiML must be track="both_tracks" for playback
            };
            twilioWS.send(JSON.stringify(frame));
          }
        }
      } catch (err) {
        console.error('[OpenAI] parse error:', err.message);
      }
    });

    openaiWS.on('close', (code, reason) => {
      console.log(`[OpenAI] WS closed ${code} ${reason}`);
      try { twilioWS.close(); } catch {}
    });

    openaiWS.on('error', (err) => {
      console.error('[OpenAI] WS error:', err.message);
      try { twilioWS.close(); } catch {}
    });
  };

  connectOpenAI();

  // 2) Handle Twilio frames
  twilioWS.on('message', (m) => {
    let msg;
    try { msg = JSON.parse(m); } catch { return; }

    switch (msg.event) {
      case 'connected':
        console.log('Twilio event: connected');
        break;

      case 'start':
        streamSid = msg.start?.streamSid;
        console.log('Twilio START:', {
          streamSid,
          mediaFormat: msg.start?.mediaFormat,
          customParameters: msg.start?.customParameters || {},
        });
        break;

      case 'media':
        // ~20ms μ-law chunk
        if (msg.media?.payload) {
          frameBuffers.push(Buffer.from(msg.media.payload, 'base64'));
          bufferedMs += 20;
          if (bufferedMs >= 200) flushToOpenAI();
        }
        break;

      case 'stop':
        console.log('Twilio STOP:', { streamSid: msg.stop?.streamSid });
        try { openaiWS && openaiWS.close(); } catch {}
        break;
    }
  });

  twilioWS.on('close', () => {
    console.log('Twilio WS closed');
    try { openaiWS && openaiWS.close(); } catch {}
    clearInterval(flushTimer);
  });

  twilioWS.on('error', (err) => {
    console.error('Twilio WS error:', err.message);
    try { openaiWS && openaiWS.close(); } catch {}
    clearInterval(flushTimer);
  });
});

// ------------------------------
server.listen(PORT, () => {
  console.log('//////////////////////////////////////////////////');
  console.log(`Available at your primary URL https://barber-ai.onrender.com`);
  console.log('//////////////////////////////////////////////////');
  console.log(`Detected service running on port ${PORT}`);
});
