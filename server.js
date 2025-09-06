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

require('dotenv').config();

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

// This prints a line even if the WS handshake fails,
// so you’ll ALWAYS see *something* in logs when Twilio tries.
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

// Only accept upgrades for our Twilio endpoint
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

    // Append caller audio to OpenAI input buffer
    try {
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

  // 1) Create OpenAI Realtime WS as soon as Twilio connects
  const connectOpenAI = () => {
    if (!OPENAI_API_KEY) {
      console.error('Missing OPENAI_API_KEY env.');
      return twilioWS.close();
    }

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      MODEL
    )}`;

    // NOTE: Subprotocol is required by OpenAI Realtime
    openaiWS = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openaiWS.on('open', () => {
      console.log('[OpenAI] WS open');

      // Configure session so formats match Twilio (μ-law 8kHz), and pick a voice
      openaiWS.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            voice: 'alloy', // stable voice name
          },
        })
      );

      openaiReady = true;

      // Send a tiny warm-up request so the model speaks even if caller is silent
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
        // Uncomment to see all events
        // console.log('[OpenAI EVENT]', msg.type);

        switch (msg.type) {
          case 'response.output_audio.delta': {
            // This is μ-law base64 audio chunk – send back to Twilio
            if (twilioWS.readyState === WebSocket.OPEN && streamSid) {
              const payload = msg.delta; // base64 μ-law 8kHz mono
              const frame = {
                event: 'media',
                streamSid,
                media: { payload },
                // Twilio will accept this when your TwiML is set to both_tracks.
                // If your Bin is inbound only, Twilio ignores outbound frames.
                track: 'outbound',
              };
              twilioWS.send(JSON.stringify(frame));
            }
            break;
          }
          case 'response.completed':
          case 'response.created':
          case 'response.delta':
          case 'response.output_text.delta':
          case 'response.output_text.done':
          case 'response.error':
          case 'session.updated':
            // Log the most useful things
            // console.log('[OpenAI]', msg.type, msg);
            break;
        }
      } catch (err) {
        console.error('[OpenAI] parse error:', err.message);
      }
    });

    openaiWS.on('close', (code, reason) => {
      console.log(`[OpenAI] WS closed ${code} ${reason}`);
      try {
        twilioWS.close();
      } catch {}
    });

    openaiWS.on('error', (err) => {
      console.error('[OpenAI] WS error:', err.message);
      try {
        twilioWS.close();
      } catch {}
    });
  };

  connectOpenAI();

  // 2) Handle incoming Twilio frames
  twilioWS.on('message', (m) => {
    let msg;
    try {
      msg = JSON.parse(m);
    } catch {
      return;
    }

    const { event } = msg;

    switch (event) {
      case 'connected': {
        console.log('Twilio event: connected');
        break;
      }
      case 'start': {
        streamSid = msg.start?.streamSid;
        console.log('Twilio START:', {
          streamSid,
          mediaFormat: msg.start?.mediaFormat,
          customParameters: msg.start?.customParameters || {},
        });
        break;
      }
      case 'media': {
        // Caller audio; Twilio gives base64 μ-law chunk (~20ms)
        const b64 = msg.media?.payload;
        if (b64) {
          frameBuffers.push(Buffer.from(b64, 'base64'));
          bufferedMs += 20; // each Twilio frame ~20ms at 8k
          // Optional: if bursts are large, flush ASAP
          if (bufferedMs >= 200) flushToOpenAI();
        }
        break;
      }
      case 'stop': {
        console.log('Twilio STOP:', { streamSid: msg.stop?.streamSid });
        try {
          openaiWS && openaiWS.close();
        } catch {}
        break;
      }
      default: {
        // console.log('Twilio event:', event);
        break;
      }
    }
  });

  twilioWS.on('close', () => {
    console.log('Twilio WS closed');
    try {
      openaiWS && openaiWS.close();
    } catch {}
    clearInterval(flushTimer);
  });

  twilioWS.on('error', (err) => {
    console.error('Twilio WS error:', err.message);
    try {
      openaiWS && openaiWS.close();
    } catch {}
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
