// server.js
// Minimal Twilio <-> OpenAI Realtime bridge (speak-only)
// Requirements: render keeps PORT env, OPENAI_API_KEY env is set

const express = require('express');
const crypto = require('crypto');
const WebSocket = require('ws');
const bodyParser = require('body-parser');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const VOICE = (process.env.POLLY_VOICE || 'alloy').toLowerCase(); // must be an OpenAI voice
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * 1) Twilio webhook -> return TwiML that connects to /media
 */
app.post('/voice', (req, res) => {
  // Simple greeting, then connect
  const twiml = `
<Response>
  <Say>Hi. I'm Barber A I. Connecting you now.</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media" />
  </Connect>
</Response>`;
  res.type('text/xml').send(twiml.trim());
});

/**
 * 2) Twilio media WS endpoint
 *    We will:
 *     - open an OpenAI Realtime WS
 *     - send a session.update (modalities, voice, output format)
 *     - send a response.create to TTS one line
 *     - forward OpenAI audio chunks to Twilio
 */
app.get('/media', (req, res) => res.status(200).send('OK')); // for local checks

const server = app.listen(process.env.PORT || 10000, () => {
  console.log(`Minimal WS server ready at https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`);
});

// Upgrade handler for WS
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/media') return;

  const wss = new WebSocket.Server({ noServer: true });
  wss.handleUpgrade(request, socket, head, ws => {
    handleTwilioStream(ws).catch(err => {
      console.error('Fatal stream error:', err);
      try { ws.close(); } catch (_e) {}
    });
  });
});

async function handleTwilioStream(twiliows) {
  let streamSid = null;

  // 2.a Open OpenAI realtime websocket
  const aiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const aiws = new WebSocket(aiUrl, {
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
      'Content-Type': 'application/json'
    }
  });

  aiws.on('open', () => {
    console.log('[OpenAI] WS open');

    // ---- IMPORTANT FIXES ----
    // Only set modalities/voice/output format at the SESSION level.
    aiws.send(JSON.stringify({
      type: 'session.update',
      session: {
        // Realtime wants BOTH text and audio allowed
        modalities: ['text', 'audio'],
        voice: VOICE, // e.g., 'alloy'
        output_audio_format: 'g711_ulaw' // EXACTLY what Twilio needs on downlink
      }
    }));

    // Create a simple one-shot TTS response. DO NOT add modalities here.
    aiws.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: 'Hello, you are connected to Barber A I.'
      }
    }));
  });

  aiws.on('close', () => {
    console.log('[OpenAI] WS closed');
    try { twiliows.close(); } catch (_e) {}
  });

  aiws.on('error', err => {
    console.error('[OpenAI] error', err);
    try { aiws.close(); } catch (_e) {}
  });

  // 2.b Forward OpenAI audio to Twilio
  aiws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch (e) { return; }

    // Realtime TTS chunks arrive as "response.output_audio.delta"
    if (
      data.type === 'response.output_audio.delta' &&
      data.delta
    ) {
      // delta is base64 of μ-law (g711_ulaw) at 8k
      if (streamSid) {
        twiliows.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: data.delta }
        }));
      }
    }

    // When a response finishes, tell Twilio we’re done with this burst
    if (data.type === 'response.completed') {
      if (streamSid) {
        twiliows.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: `resp_${data.response?.id || crypto.randomUUID()}` }
        }));
      }
    }

    // Log errors clearly so we can see parameter issues
    if (data.type === 'error' || data.type === 'response.error') {
      console.error('[OpenAI ERROR]', JSON.stringify(data, null, 2));
    }
  });

  // 2.c Twilio -> we only need streamSid and heartbeats for this “speak-only” version
  twiliows.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    switch (evt.event) {
      case 'start':
        streamSid = evt.start.streamSid;
        console.log('[Twilio] start', streamSid);
        break;

      case 'media':
        // For this speak-only minimal version we ignore inbound audio.
        // (When you want listening, buffer & commit 100ms+ to OpenAI with input_audio_buffer.*)
        break;

      case 'stop':
        console.log('[Twilio] stop');
        try { aiws.close(); } catch (_e) {}
        break;
    }
  });

  twiliows.on('close', () => {
    console.log('[Twilio] closed');
    try { aiws.close(); } catch (_e) {}
  });
}
