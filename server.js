// server.js (CommonJS)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// --- TwiML helper for quick health check
app.get('/', (_req, res) => res.send('OK'));

// Twilio <Connect><Stream> should point to: wss://<your-host>/media
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => twilioMediaHandler(ws));
  } else {
    socket.destroy();
  }
});

/**
 * Handle a single Twilio <Stream> connection and bridge it to OpenAI Realtime.
 */
function twilioMediaHandler(twilioWS) {
  console.log('WS CONNECTED on /media from ::1');

  // Connect to OpenAI Realtime WS
  const oaWS = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  // Accumulate 20ms μ-law frames; commit ≥200ms (10 frames).
  const BYTES_PER_20MS_ULAW = 160; // 8kHz * 8bit * 0.02s = 160
  const COMMIT_BYTES = BYTES_PER_20MS_ULAW * 10; // 200ms
  let ulawBuffer = Buffer.alloc(0);

  let openAIReady = false;
  let twilioAlive = true;

  // --- Twilio WS incoming messages
  twilioWS.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const event = data.event;

    if (event === 'start') {
      console.log('Twilio START:', data.start?.streamSid);
    } else if (event === 'media') {
      // Inbound caller audio frame (20ms @ G.711 u-law)
      const b64 = data.media?.payload;
      if (!b64) return;

      const chunk = Buffer.from(b64, 'base64');
      ulawBuffer = Buffer.concat([ulawBuffer, chunk]);

      // Commit every ≥200ms to avoid "buffer too small"
      if (openAIReady && ulawBuffer.length >= COMMIT_BYTES) {
        // append -> commit -> response.create
        const audioB64 = ulawBuffer.toString('base64');
        ulawBuffer = Buffer.alloc(0);

        oaWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: audioB64,
        }));
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

        // Ask the model to respond with audio+text
        oaWS.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['audio','text'],
            conversation: 'default',
          },
        }));
      }
    } else if (event === 'stop') {
      console.log('Twilio STOP');
      twilioAlive = false;
      try { oaWS.close(); } catch {}
      try { twilioWS.close(); } catch {}
    }
  });

  twilioWS.on('close', () => {
    twilioAlive = false;
    try { oaWS.close(); } catch {}
  });

  twilioWS.on('error', (e) => {
    console.error('Twilio WS error:', e);
    twilioAlive = false;
    try { oaWS.close(); } catch {}
  });

  // --- OpenAI WS lifecycle
  oaWS.on('open', () => {
    console.log('[OpenAI] WS open');

    // Configure the session for μ-law in/out and audio+text responses
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        // Twilio sends G.711 μ-law
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // provide short natural back-and-forth
        response: {
          modalities: ['audio','text'],
          instructions: 'You are a concise, friendly barber shop assistant. Speak briefly and ask one question at a time.',
          voice: 'verse'
        },
        // Optional server VAD
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 200,
          silence_duration_ms: 600
        }
      }
    }));

    // Optional greeting
    oaWS.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio','text'],
        conversation: 'default',
        instructions: 'Greet the caller briefly and ask how you can help.'
      }
    }));

    openAIReady = true;
  });

  // Stream OpenAI audio back to Twilio
  oaWS.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // The realtime API will send audio deltas when output_audio_format is g711_ulaw
    if (msg.type === 'response.output_audio.delta' && msg.delta) {
      // `msg.delta` is base64-encoded audio; forward to Twilio
      if (twilioAlive) {
        twilioWS.send(JSON.stringify({
          event: 'media',
          media: { payload: msg.delta }
        }));
      }
    }

    // Helpful to log errors coming from OpenAI
    if (msg.type === 'error') {
      console.error('[OpenAI ERROR]', msg);
    }
  });

  oaWS.on('close', () => {
    console.log('[OpenAI] WS closed');
    if (twilioAlive) {
      try { twilioWS.close(); } catch {}
    }
  });

  oaWS.on('error', (e) => {
    console.error('[OpenAI] WS error:', e);
    if (twilioAlive) {
      try { twilioWS.close(); } catch {}
    }
  });
}

server.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`Available at your primary URL https://barber-ai.onrender.com`);
});
