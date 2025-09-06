// Minimal speak-only Twilio <-> OpenAI Realtime bridge with verbose logging.
// Purpose: make OpenAI *say one line* over the phone reliably.

const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
// Use a valid OpenAI realtime voice. If POLLY_VOICE is set to an AWS voice like "Matthew",
// we ignore it and default to "alloy".
const VOICE = (process.env.POLLY_VOICE || 'alloy').toLowerCase();
const VALID_VOICES = new Set(['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar']);
const OPENAI_VOICE = VALID_VOICES.has(VOICE) ? VOICE : 'alloy';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY'); process.exit(1);
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Twilio webhook: answer and bridge to WS ---
app.post('/voice', (req, res) => {
  const host = req.headers.host; // e.g. barber-ai.onrender.com
  const twiml = `
<Response>
  <Say>Hi, this is Barber A I. Connecting you now.</Say>
  <Connect>
    <Stream url="wss://${host}/media"/>
  </Connect>
</Response>`.trim();
  res.type('text/xml').send(twiml);
});

const server = app.listen(PORT, () => {
  console.log(`==> Minimal WS server ready at https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`);
});

// ---- One WS server bound to /media ----
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/media') return;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (twilioWS) => {
  console.log('[Twilio] WS connected');
  let streamSid = null;
  let gotAnyOpenAIMessage = false;

  // Open OpenAI Realtime WS
  const aiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const aiWS = new WebSocket(aiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
      'Content-Type': 'application/json'
    }
  });

  // ---- Twilio -> server events ----
  twilioWS.on('message', (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === 'start') {
      streamSid = evt.start.streamSid;
      console.log('[Twilio] start', streamSid);
    } else if (evt.event === 'media') {
      // speak-only; ignore inbound audio
    } else if (evt.event === 'stop') {
      console.log('[Twilio] stop');
      try { aiWS.close(); } catch {}
      try { twilioWS.close(); } catch {}
    }
  });

  twilioWS.on('close', () => {
    console.log('[Twilio] closed');
    try { aiWS.close(); } catch {}
  });

  // ---- OpenAI WS lifecycle ----
  aiWS.on('open', () => {
    console.log('[OpenAI] WS open');

    // Configure session ONCE (this was the source of previous errors).
    // Only set modalities/voice/output format at SESSION level.
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'], // allow the model to produce audio
        voice: OPENAI_VOICE,           // a valid OpenAI voice
        output_audio_format: 'g711_ulaw' // Twilio expects μ-law 8k
      }
    };
    aiWS.send(JSON.stringify(sessionUpdate));
    console.log('[OpenAI] -> session.update', sessionUpdate.session);

    // Ask the model to speak one sentence.
    const respCreate = {
      type: 'response.create',
      response: {
        instructions: 'Hello, you are connected to Barber A I.'
      }
    };
    aiWS.send(JSON.stringify(respCreate));
    console.log('[OpenAI] -> response.create');
  });

  aiWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      console.log('[OpenAI] (non-JSON message of length)', raw.length);
      return;
    }
    gotAnyOpenAIMessage = true;

    // Log everything for now
    if (msg.type !== 'response.output_audio.delta') {
      console.log('[OpenAI] <-', msg.type);
    }

    // Forward audio chunks to the caller
    if (msg.type === 'response.output_audio.delta' && msg.delta && streamSid) {
      twilioWS.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: msg.delta }
      }));
    }

    // When that one response completes, mark it (optional)
    if (msg.type === 'response.completed' && streamSid) {
      twilioWS.send(JSON.stringify({
        event: 'mark',
        streamSid,
        mark: { name: `resp_${msg.response?.id || 'done'}` }
      }));
    }

    // Surface any errors loudly
    if (msg.type === 'error' || msg.type === 'response.error') {
      console.error('[OpenAI ERROR]', JSON.stringify(msg, null, 2));
    }
  });

  aiWS.on('close', () => {
    console.log('[OpenAI] WS closed');
    try { twilioWS.close(); } catch {}
  });

  aiWS.on('error', (err) => {
    console.error('[OpenAI] error', err);
    try { aiWS.close(); } catch {}
  });

  // Safety: if OpenAI sends nothing for 3 seconds, log that explicitly
  setTimeout(() => {
    if (!gotAnyOpenAIMessage) {
      console.warn('[Warn] No messages from OpenAI in first 3s. Check API key, model, or headers.');
    }
  }, 3000);
});
