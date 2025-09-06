// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const OPENAI_MODEL = 'gpt-4o-realtime-preview-2024-12-17'; // your realtime model
const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;

// Twilio sends 20ms G.711 μ-law frames
const TWILIO_FRAME_MS = 20;
// Commit to OpenAI only when we have >=100ms (5 frames). You can bump to 200ms if needed.
const COMMIT_MS = 100;
const FRAMES_PER_COMMIT = Math.ceil(COMMIT_MS / TWILIO_FRAME_MS);

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => res.send('OK'));

// --- Upgrade /media to WS for Twilio ---
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (twilioWs) => {
  // 1) Connect to OpenAI Realtime
  const openaiWs = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  // Track inbound audio batching
  let ulawChunks = [];
  let frameCount = 0;

  // Helper: send session settings + ask the model to speak
  const startOpenAISession = () => {
    // Configure the session (formats, voice)
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        voice: 'verse', // pick any supported voice
        input_audio_format:  { type: 'g711_ulaw' },
        output_audio_format: { type: 'g711_ulaw' },
        // optional server-side VAD:
        turn_detection: { type: 'server_vad' }
      }
    }));

    // Create an initial response so it talks immediately
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions: 'You are Barber AI. Greet the caller and ask how you can help.'
      }
    }));
  };

  // 2) OpenAI events -> send audio back to Twilio
  openaiWs.on('message', (msg) => {
    try {
      const evt = JSON.parse(msg.toString());

      // audio coming from OpenAI in G.711 μ-law base64
      if (evt.type === 'response.audio.delta' && evt.delta) {
        // Twilio expects {"event":"media","media":{"payload":"<base64>"}}
        twilioWs.send(JSON.stringify({
          event: 'media',
          media: { payload: evt.delta }
        }));
      }

      // If OpenAI indicates “response ended”, you can start another response here,
      // or rely on VAD + your own triggers.
      // if (evt.type === 'response.completed') { ... }

    } catch (e) {
      console.error('OpenAI msg parse error', e);
    }
  });

  openaiWs.on('open', startOpenAISession);
  openaiWs.on('close', () => {
    try { twilioWs.close(); } catch {}
  });
  openaiWs.on('error', (e) => console.error('OpenAI WS error', e));

  // 3) Twilio events -> send audio to OpenAI (batched)
  twilioWs.on('message', (msg) => {
    try {
      const evt = JSON.parse(msg.toString());

      if (evt.event === 'media' && evt.media && evt.media.payload) {
        ulawChunks.push(Buffer.from(evt.media.payload, 'base64'));
        frameCount++;

        if (frameCount >= FRAMES_PER_COMMIT) {
          const ulawBuf = Buffer.concat(ulawChunks);
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: ulawBuf.toString('base64')
          }));
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

          ulawChunks = [];
          frameCount = 0;
        }
      }

      if (evt.event === 'start') {
        // Twilio stream started (good for logging)
        // console.log('Twilio START', evt.start);
      }

      if (evt.event === 'stop') {
        // Flush any remainder if it’s >=100ms
        if (frameCount >= FRAMES_PER_COMMIT) {
          const ulawBuf = Buffer.concat(ulawChunks);
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: ulawBuf.toString('base64')
          }));
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
        try { openaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
      }
    } catch (e) {
      console.error('Twilio msg parse error', e);
    }
  });

  twilioWs.on('close', () => {
    try { openaiWs.close(); } catch {}
  });
  twilioWs.on('error', (e) => console.error('Twilio WS error', e));
});

// Render listens on PORT; we only need it for health checks
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
