// server.js  — CommonJS
require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const OPENAI_REALTIME_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

const app = express();

// simple health probe
app.get('/health', (_req, res) => res.status(200).send('ok'));

// *** IMPORTANT: create a real HTTP server and attach ws to it ***
const server = http.createServer(app);

// One WebSocket server that accepts Twilio <Stream> on path `/twilio`
const twilioWSS = new WebSocketServer({ server, path: '/twilio' });

twilioWSS.on('connection', (twilioWS, req) => {
  console.log('Twilio WS connected. From:', req.socket.remoteAddress);

  // Open a Realtime WS to OpenAI
  const openaiWS = new (require('ws'))(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let mediaStarted = false;

  // ---- batching for ≥100ms (Twilio sends ~20ms PCMU frames) ----
  const frameQueue = [];
  let queuedMs = 0;
  const FRAME_MS = 20;   // Twilio default
  const COMMIT_MS = 100; // must be ≥ 100ms for OpenAI

  const flushAudioIfReady = () => {
    if (queuedMs < COMMIT_MS || frameQueue.length === 0) return;

    const combined = Buffer.concat(frameQueue);
    const base64 = combined.toString('base64');

    // Append and Commit to OpenAI
    safeSend(openaiWS, {
      type: 'input_audio_buffer.append',
      audio: base64,
    });

    safeSend(openaiWS, { type: 'input_audio_buffer.commit' });

    // Ask OpenAI to speak a short reply (keeps conversation flowing)
    safeSend(openaiWS, {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        conversation: 'default',
        instructions:
          'You are a friendly phone agent. Keep replies short and conversational.',
      },
    });

    frameQueue.length = 0;
    queuedMs = 0;
  };

  const safeSend = (socket, obj) => {
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  };

  // When OpenAI WS opens, configure session & say hello
  openaiWS.on('open', () => {
    console.log('OpenAI WS open');

    // Configure session: ulaw in/out, modalities audio+text, voice "verse"
    safeSend(openaiWS, {
      type: 'session.update',
      session: {
        input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
        modalities: ['audio', 'text'],
        voice: 'verse',
      },
    });

    // Greeting so caller hears something even before speaking
    safeSend(openaiWS, {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        conversation: 'default',
        instructions:
          'Say: "Hi—thanks for calling! I am connected and listening."',
      },
    });
  });

  openaiWS.on('message', (data) => {
    // If you want to forward OpenAI audio back to Twilio, you’d decode/bridge here.
    // For now we just log so we can stay focused on stabilizing the bridge.
    try {
      const msg = JSON.parse(data.toString());
      // Debug minimal
      if (msg.type === 'error') console.error('OpenAI ERROR:', msg);
    } catch (_) {}
  });

  openaiWS.on('close', () => console.log('OpenAI WS closed'));
  openaiWS.on('error', (err) => console.error('OpenAI WS error:', err));

  // Handle inbound Twilio messages
  twilioWS.on('message', (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.event === 'start') {
      console.log('Twilio media START:', evt.start?.streamSid);
      mediaStarted = true;
      return;
    }

    if (evt.event === 'media' && mediaStarted) {
      // Twilio payload is base64 PCMU; keep as bytes and batch for ≥100ms
      const chunk = Buffer.from(evt.media.payload, 'base64');
      frameQueue.push(chunk);
      queuedMs += FRAME_MS;
      flushAudioIfReady();
      return;
    }

    if (evt.event === 'stop') {
      console.log('Twilio media STOP');
      flushAudioIfReady();
      try { openaiWS.close(); } catch (_) {}
      try { twilioWS.close(); } catch (_) {}
      return;
    }
  });

  twilioWS.on('close', () => {
    console.log('Twilio WS closed');
    try { openaiWS.close(); } catch (_) {}
  });

  twilioWS.on('error', (err) => console.error('Twilio WS error:', err));
});

// Start HTTP+WS server
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
  console.log('Your service is live 🎉');
  console.log('Available at your primary URL https://barber-ai.onrender.com');
});
