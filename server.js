// server.js  (CommonJS)
// Minimal Twilio <-> OpenAI Realtime bridge with µ-law pass-through.
// Requires: express, ws, cors, body-parser, dotenv

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// simple health
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) => res.send('healthy'));

// optional Twilio status callback for debugging
app.post('/twilio-status', (req, res) => {
  try {
    console.log('Twilio status callback body:', JSON.stringify(req.body || {}, null, 2));
  } catch {}
  res.sendStatus(200);
});

const server = http.createServer(app);

// Attach a WS server and handle Twilio upgrades on /twilio
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/twilio')) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---------- Helper: Create OpenAI Realtime WS ----------
function connectOpenAI() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1',
  };
  return new WebSocket(url, { headers });
}

// ---------- Twilio <-> OpenAI bridge ----------
wss.on('connection', (twilioWS, req) => {
  console.log('WS CONNECTED on /twilio from', req.socket.remoteAddress);

  // per-call state
  let openaiWS = null;
  let streamSid = null;

  // For batching commits: Twilio sends 20ms frames; commit each 5 frames (100ms)
  let framesSinceCommit = 0;

  function safeSend(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // OpenAI connection
  openaiWS = connectOpenAI();

  openaiWS.on('open', () => {
    console.log('[OpenAI] WS open');

    // Configure the OpenAI session correctly (strings, not objects)
    safeSend(openaiWS, {
      type: 'session.update',
      session: {
        // Twilio is sending µ-law 8k mono; pass-thru both directions:
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',

        // Must be ["text"] or ["audio","text"]
        modalities: ['audio', 'text'],

        // reasonable defaults
        voice: 'verse',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 200,
          silence_duration_ms: 500
        }
      }
    });

    // Initial greeting so you hear speech immediately
    safeSend(openaiWS, {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions:
          "You are BarberAI, a friendly barber shop assistant. Greet the caller right away and say: 'Hi! This is BarberAI. How can I help you today?' Keep it short."
      }
    });
  });

  // Forward OpenAI audio deltas back to Twilio
  openaiWS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Stream audio back as Twilio 'media' frames (already µ-law)
    if (msg.type === 'response.output_audio.delta' && msg.delta) {
      if (streamSid) {
        safeSend(twilioWS, {
          event: 'media',
          streamSid,
          media: { payload: msg.delta } // base64 μ-law from OpenAI
        });
      }
    }

    // Optional: when a response completes you can mark, etc.
    if (msg.type === 'response.completed') {
      if (streamSid) {
        safeSend(twilioWS, {
          event: 'mark',
          streamSid,
          mark: { name: 'openai_response_completed' }
        });
      }
    }

    if (msg.type && msg.type.endsWith('.error')) {
      console.error('[OpenAI ERROR]', msg);
    }
  });

  openaiWS.on('error', (err) => {
    console.error('[OpenAI] error:', err);
  });

  openaiWS.on('close', () => {
    console.log('[OpenAI] WS closed');
  });

  // Twilio WS inbound
  twilioWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const { event } = msg;

    if (event === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('Twilio START, streamSid:', streamSid);

    } else if (event === 'media') {
      // One 20ms µ-law frame from Twilio
      const b64 = msg.media?.payload;
      if (!b64 || !openaiWS || openaiWS.readyState !== WebSocket.OPEN) return;

      // Append the 20ms chunk immediately
      safeSend(openaiWS, { type: 'input_audio_buffer.append', audio: b64 });

      framesSinceCommit += 1;
      if (framesSinceCommit >= 5) { // 5 * 20ms = 100ms
        safeSend(openaiWS, { type: 'input_audio_buffer.commit' });
        framesSinceCommit = 0;
      }

    } else if (event === 'stop') {
      console.log('Twilio STOP');
      try { openaiWS?.close(); } catch {}
      try { twilioWS?.close(); } catch {}
    }
  });

  twilioWS.on('close', () => {
    console.log('Twilio WS closed');
    try { openaiWS?.close(); } catch {}
  });

  twilioWS.on('error', (err) => {
    console.error('Twilio WS error:', err);
    try { openaiWS?.close(); } catch {}
  });

  // keep-alive pings to avoid idle closures
  const pingIv = setInterval(() => {
    if (twilioWS.readyState === WebSocket.OPEN) twilioWS.ping();
    if (openaiWS?.readyState === WebSocket.OPEN) openaiWS.ping();
  }, 15000);
  twilioWS.on('close', () => clearInterval(pingIv));
  if (openaiWS) openaiWS.on('close', () => clearInterval(pingIv));
});

server.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
