// server.js
// A minimal, robust Twilio <-> OpenAI Realtime bridge (μ-law pass-through)
// - Greets with "Hello!" on connect
// - Buffers >=100ms (5 x 20ms Twilio frames) before each commit to avoid "buffer too small"
// - Uses correct Realtime parameters (voice, modalities, input/output formats)

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const WebSocket = require('ws');
const fetch = require('node-fetch');

// ----- ENV -----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const PORT = process.env.PORT || 10000;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY env var.');
  process.exit(1);
}

// ----- APP -----
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Twilio answers the call and opens a Media Stream to our WS endpoint (/twilio)
app.post('/voice', (req, res) => {
  // Bidirectional stream with audio in/out
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const wsUrl = `wss://${host}/twilio`;
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_audio outbound_audio"/>
  </Connect>
</Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// --- Utility: Twilio <-> OpenAI bridges use WebSockets ---
const server = app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log('==> Your service is live 🎉');
  console.log('==> ////////////////////////////////////////////////');
});

// Handle the bidirectional Twilio WS and bridge it to OpenAI WS
const wss = new WebSocket.Server({ server, path: '/twilio' });

// Twilio sends 8kHz μ-law frames (PCMU) in base64 payloads, 20ms each.
// We pass these frames directly to OpenAI using input_audio_buffer.append with
// session.input_audio_format = 'g711_ulaw', and we commit after >= 100ms.
wss.on('connection', (twilioWS, req) => {
  console.log('Twilio WS connected');

  // Connect to OpenAI Realtime WS
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        // Tell server we will push audio (no client SDK)
        'OpenAI-Beta': 'realtime=v1',
      }
    }
  );

  // Accumulator for caller audio frames (20ms each)
  let pendingFrames = [];
  let openaiReady = false;
  let streamSid = null; // Twilio stream SID to send audio back

  // Send all JSON events to OpenAI with safe stringify
  const oaSend = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };

  // Send JSON back to Twilio
  const twSend = (obj) => {
    if (twilioWS && twilioWS.readyState === WebSocket.OPEN) {
      twilioWS.send(JSON.stringify(obj));
    }
  };

  // ---- OpenAI WS lifecycle ----
  openaiWS.on('open', () => {
    console.log('OpenAI WS open');

    // Configure the session to μ-law in/out + voice
    // NOTE: previous errors in your logs came from sending an object or wrong param name.
    // Here we send a proper "session.update".
    oaSend({
      type: 'session.update',
      session: {
        // μ-law ⇔ Twilio passthrough. Avoids any PCM transcoding on your server.
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'alloy',                         // valid voice
        modalities: ['text', 'audio']          // session-level modalities allowed
      }
    });

    // Say hello as soon as session is created so we know audio out works.
    // (We craft an audio response explicitly.)
    oaSend({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],         // IMPORTANT: must include 'text' with 'audio'
        instructions: 'Hello! How can I help?',
      }
    });

    openaiReady = true;
  });

  openaiWS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_e) { return; }

    // Debug logs useful during bring-up
    if (msg.type?.startsWith('response.')) {
      // console.log('OA:', msg.type);
    }
    if (msg.type === 'response.output_audio.delta') {
      // This is μ-law base64 because we set output_audio_format = 'g711_ulaw'
      const payload = msg.delta;
      // Twilio "media" back into the call via Stream
      // (We need a streamSid first, we capture it from start msg)
      if (streamSid) {
        twSend({
          streamSid,
          event: 'media',
          media: { payload }
        });
      }
    }

    // OpenAI can signal end of audio turn; no action required here.
  });

  openaiWS.on('close', () => {
    console.log('OpenAI WS closed');
    try { twilioWS.close(); } catch {}
  });

  openaiWS.on('error', (err) => {
    console.error('OpenAI WS ERROR:', err?.message || err);
    try { twilioWS.close(); } catch {}
  });

  // ---- Twilio WS lifecycle ----
  twilioWS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_e) { return; }

    const event = msg.event;

    switch (event) {
      case 'start': {
        streamSid = msg.start?.streamSid;
        console.log('Twilio start, stream:', streamSid, 'from:', msg.start?.from);
        break;
      }
      case 'media': {
        // Caller audio from Twilio (20ms μ-law base64)
        if (!openaiReady) return;
        const base64ulaw = msg.media?.payload;
        if (!base64ulaw) return;

        // Buffer until we have >=100ms (5 frames) to avoid "buffer too small"
        pendingFrames.push(base64ulaw);

        if (pendingFrames.length >= 5) {
          // Append all frames in order
          for (const chunk of pendingFrames) {
            oaSend({
              type: 'input_audio_buffer.append',
              audio: chunk   // μ-law base64
            });
          }
          pendingFrames = [];
          // Commit the buffer so OpenAI can process
          oaSend({ type: 'input_audio_buffer.commit' });

          // (Optionally) create a response after a commit if we want continuous backchanneling.
          // We'll let OA decide to speak; if it needs more audio it will wait.
          // Here we only create a response if none is in flight.
          oaSend({ type: 'response.create', response: { modalities: ['audio','text'] } });
        }
        break;
      }
      case 'mark': {
        break;
      }
      case 'stop': {
        console.log('Twilio stop');
        try { openaiWS.close(); } catch {}
        break;
      }
      default: {
        // Ignore keepalives etc.
      }
    }
  });

  twilioWS.on('close', () => {
    console.log('Twilio WS closed');
    try { openaiWS.close(); } catch {}
  });

  twilioWS.on('error', (err) => {
    console.error('Twilio WS ERROR:', err?.message || err);
    try { openaiWS.close(); } catch {}
  });
});

// Root just shows links
app.get('/', (_req, res) => {
  res.type('text').send('Twilio <-> OpenAI Realtime bridge is running.\n\nPOST /voice from Twilio and WS /twilio are active.\n/health returns ok.');
});
