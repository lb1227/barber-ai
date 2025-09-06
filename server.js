// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const OPENAI_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;

const TWILIO_FRAME_MS = 20;
const COMMIT_MS = 100;                       // bump to 200 if needed
const FRAMES_PER_COMMIT = Math.ceil(COMMIT_MS / TWILIO_FRAME_MS);

const app = express();
const server = http.createServer(app);

app.get('/', (_, res) => res.send('OK'));

// Upgrade only /media to WS for Twilio
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (twilioWs) => {
  // ---------- Connect to OpenAI ----------
  const openaiWs = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  let openaiReady = false;

  // Twilio inbound frame buffering
  let ulawChunks = [];
  let frameCount = 0;

  // Optional: cap how much we buffer before OpenAI opens (avoid unbounded RAM)
  const MAX_BUFFERED_FRAMES = 200; // ~4s at 20ms
  let bufferedFrames = 0;

  const safeSendToOpenAI = (payload) => {
    if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) return false;
    try { openaiWs.send(JSON.stringify(payload)); return true; } catch { return false; }
  };

  // Flush any buffered frames in >=100ms commits
  const flushBuffered = () => {
    if (!openaiReady) return;
    while (frameCount >= FRAMES_PER_COMMIT) {
      const ulawBuf = Buffer.concat(ulawChunks.splice(0, FRAMES_PER_COMMIT));
      frameCount -= FRAMES_PER_COMMIT;
      safeSendToOpenAI({
        type: 'input_audio_buffer.append',
        audio: ulawBuf.toString('base64')
      });
      safeSendToOpenAI({ type: 'input_audio_buffer.commit' });
    }
  };

  const startOpenAISession = () => {
    safeSendToOpenAI({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        voice: 'verse',
        input_audio_format:  { type: 'g711_ulaw' },
        output_audio_format: { type: 'g711_ulaw' },
        turn_detection: { type: 'server_vad' }
      }
    });

    // Initial greeting
    safeSendToOpenAI({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions: 'You are Barber AI. Greet the caller and ask how you can help.'
      }
    });

    // Now that OpenAI is ready, flush anything we buffered while connecting
    flushBuffered();
  };

  // ---------- OpenAI -> Twilio ----------
  openaiWs.on('open', () => {
    openaiReady = true;
    startOpenAISession();
  });

  openaiWs.on('message', (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      if (evt.type === 'response.audio.delta' && evt.delta) {
        twilioWs.send(JSON.stringify({ event: 'media', media: { payload: evt.delta } }));
      }
    } catch (e) {
      console.error('OpenAI msg parse error', e);
    }
  });

  openaiWs.on('close', () => { try { twilioWs.close(); } catch {} });
  openaiWs.on('error', (e) => console.error('OpenAI WS error', e));

  // ---------- Twilio -> OpenAI ----------
  twilioWs.on('message', (msg) => {
    try {
      const evt = JSON.parse(msg.toString());

      if (evt.event === 'media' && evt.media?.payload) {
        ulawChunks.push(Buffer.from(evt.media.payload, 'base64'));
        frameCount++;
        bufferedFrames++;

        // If OpenAI is ready, flush in >=100ms commits
        if (openaiReady) {
          flushBuffered();
          bufferedFrames = 0;
        } else {
          // Still connecting; prevent unbounded buffering
          if (bufferedFrames > MAX_BUFFERED_FRAMES) {
            // drop oldest 100ms worth to keep memory bounded
            ulawChunks = ulawChunks.slice(FRAMES_PER_COMMIT);
            frameCount -= FRAMES_PER_COMMIT;
            bufferedFrames -= FRAMES_PER_COMMIT;
          }
        }
      }

      if (evt.event === 'stop') {
        // On stop, flush if ready
        if (openaiReady) flushBuffered();
        try { openaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
      }
    } catch (e) {
      console.error('Twilio msg parse error', e);
    }
  });

  twilioWs.on('close', () => { try { openaiWs.close(); } catch {} });
  twilioWs.on('error', (e) => console.error('Twilio WS error', e));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server listening on', PORT));
