// src/server.js
/* eslint-disable no-console */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');

const PORT = process.env.PORT || 10000;

// ======= ENV you must set on Render =======
// OPENAI_API_KEY
// ==========================================

const OPENAI_HOST = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
const OPENAI_HEADERS = {
  'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
  'OpenAI-Beta': 'realtime=v1'
};

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

function log(...args) {
  console.log(new Date().toLocaleString(), ...args);
}

app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// Optional: Twilio status callbacks so you see stream errors in Render logs
app.post('/twilio-status', (req, res) => {
  log('Twilio status callback body:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

/**
 * Twilio <Stream> will connect here (wss://.../twilio)
 * We act as a bridge to OpenAI Realtime WS.
 */
app.ws = function (server, path, handler) {
  const wss = new WebSocket.Server({ server, path });
  wss.on('connection', handler);
  return wss;
};

const server = http.createServer(app);

// Add WS support to Express
require('express-ws')(app, server);

// --------------- Twilio WS ---------------
app.ws('/twilio', (twilioWS) => {
  const streamSidRef = { current: null };

  log('==> HTTP UPGRADE from Twilio OK');
  // Create OpenAI Realtime WS
  const openaiWS = new WebSocket(OPENAI_HOST, { headers: OPENAI_HEADERS });

  // Audio batching state (we need ≥100ms before commit)
  let pendingAudioSeq = 0;
  let bufferedFrames = 0;        // how many ~20ms frames we’ve collected
  let lastChunkId = null;        // the chunk_id we’ll commit when we reach 5
  const TWILIO_FRAME_MS = 20;
  const FRAMES_PER_COMMIT = Math.ceil(100 / TWILIO_FRAME_MS); // 5

  function sendToOpenAI(obj) {
    if (openaiWS.readyState !== WebSocket.OPEN) return;
    openaiWS.send(JSON.stringify(obj));
  }

  function sendToTwilio(obj) {
    if (twilioWS.readyState !== WebSocket.OPEN) return;
    twilioWS.send(JSON.stringify(obj));
  }

  // -------- OpenAI events -> Twilio --------
  openaiWS.on('open', () => {
    log('OpenAI WS open');
    // Configure the session to μ-law both ways, and a supported voice.
    sendToOpenAI({
      type: 'session.update',
      session: {
        // μ-law input from Twilio
        input_audio_format: 'g711_ulaw',
        // μ-law output back to Twilio
        output_audio_format: 'g711_ulaw',
        // a supported voice
        voice: 'verse'
      }
    });

    // Kick off: create a response (audio + text) so the model can talk back
    sendToOpenAI({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'], // IMPORTANT: include text + audio
        instructions: "You're connected. Greet the caller briefly and listen."
      }
    });
  });

  // Forward OpenAI audio deltas to Twilio as μ-law media
  openaiWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    // Audio deltas (OpenAI > Twilio)
    if (msg.type === 'response.output_audio.delta' && msg.delta) {
      // msg.delta is base64 μ-law because we set output_audio_format: g711_ulaw
      sendToTwilio({
        event: 'media',
        streamSid: streamSidRef.current,
        media: { payload: msg.delta }
      });
      return;
    }

    // Response completed: tell Twilio we’ve finished this burst of audio
    if (msg.type === 'response.completed') {
      sendToTwilio({ event: 'mark', streamSid: streamSidRef.current, mark: { name: 'openai_end_chunk' } });
      return;
    }

    // Any errors from OpenAI — log them
    if (msg.type === 'error') {
      log('OpenAI ERROR:', JSON.stringify(msg, null, 2));
      return;
    }
  });

  openaiWS.on('close', () => log('OpenAI WS closed'));
  openaiWS.on('error', (e) => log('OpenAI WS error:', e.message || e));

  // -------- Twilio events -> OpenAI --------
  twilioWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.event === 'connected') {
      log('Twilio event: connected');
      return;
    }

    if (msg.event === 'start') {
      streamSidRef.current = msg.start?.streamSid;
      log('media START { streamSid:', streamSidRef.current, '}');
      return;
    }

    // Caller audio (μ-law base64)
    if (msg.event === 'media') {
      if (!msg.media || !msg.media.payload) return;

      // Assign a chunk_id; 1 per frame
      const chunkId = String(pendingAudioSeq++);
      lastChunkId = chunkId;

      // 1) append the 20ms frame
      sendToOpenAI({
        type: 'input_audio_buffer.append',
        audio: msg.media.payload,     // base64 μ-law frame
        chunk_id: chunkId
      });

      bufferedFrames += 1;

      // 2) only commit after ≥100ms (5 frames)
      if (bufferedFrames >= FRAMES_PER_COMMIT) {
        sendToOpenAI({ type: 'input_audio_buffer.commit', chunk_id: lastChunkId });
        bufferedFrames = 0;

        // 3) Tell the model to respond (audio+text). This can be per commit,
        //    or you can throttle if you want fewer responses.
        sendToOpenAI({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            instructions: 'Listen and respond briefly.'
          }
        });
      }
      return;
    }

    if (msg.event === 'stop') {
      log('media STOP');
      try { openaiWS.close(); } catch (_) {}
      return;
    }
  });

  twilioWS.on('close', () => {
    log('Twilio WS closed');
    try { openaiWS.close(); } catch (_) {}
  });

  twilioWS.on('error', (e) => log('Twilio WS error:', e.message || e));
});

// Bring the server up
server.listen(PORT, () => {
  log('Server listening on', PORT);
  log('Your service is live 🎉');
  log('//////////////////////////////////////////');
  log('Available at your primary URL https://barber-ai.onrender.com');
  log('//////////////////////////////////////////');
});
