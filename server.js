// server.js
// Minimal Twilio <-> OpenAI Realtime bridge (μ-law in/out, 200ms commits)

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Simple health + Twilio status callback for sanity checks
app.get('/', (_, res) => res.send('OK'));
app.post('/twilio-status', (req, res) => {
  console.log('[Twilio StatusCallback] body:', req.body);
  res.sendStatus(200);
});

const server = http.createServer(app);

// We’ll handle WS upgrades ourselves for /media (Twilio’s Stream)
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => handleTwilioWS(ws, req));
  } else {
    socket.destroy();
  }
});

function handleTwilioWS(twilioWS, req) {
  console.log('WS CONNECTED on /media from', req.socket.remoteAddress);

  // --- OpenAI Realtime WS ---
  const openaiURL =
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

  const openaiWS = new WebSocket(openaiURL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // Buffer 20ms G.711 μ-law frames from Twilio here
  let frameBuffer = [];
  let lastCommit = Date.now();
  const COMMIT_EVERY_MS = 200; // >=100ms required; 200ms is comfortable

  openaiWS.on('open', () => {
    console.log('[OpenAI] WS open');

    // Tell OpenAI our formats (μ-law both ways) and to produce audio
    openaiWS.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
        },
      })
    );

    // Small greeting so we know audio is flowing back
    openaiWS.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio'],
          instructions:
            'You are a friendly phone assistant. Greet the caller briefly.',
        },
      })
    );
  });

  // Forward audio from OpenAI to Twilio
  openaiWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'output_audio_buffer.append' && msg.audio) {
        // Twilio expects {event:'media', media:{payload: base64_ulaw}}
        twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
      } else if (msg.type?.startsWith('error')) {
        console.error('[OpenAI ERROR]', msg);
      }
    } catch (e) {
      // Some frames can be binary (ignore)
    }
  });

  openaiWS.on('close', () => {
    console.log('[OpenAI] WS closed');
    try { twilioWS.close(1000); } catch {}
  });
  openaiWS.on('error', (err) => console.error('[OpenAI WS error]', err));

  // Handle Twilio events
  twilioWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === 'start') {
      console.log(
        '[Twilio] START, streamSid:',
        msg?.start?.streamSid || '(unknown)'
      );
    }

    if (msg.event === 'media') {
      // Collect 20ms μ-law frame
      frameBuffer.push(msg.media.payload);

      // Commit every COMMIT_EVERY_MS with all frames we have
      const now = Date.now();
      if (
        now - lastCommit >= COMMIT_EVERY_MS &&
        frameBuffer.length > 0 &&
        openaiWS.readyState === WebSocket.OPEN
      ) {
        const joined = frameBuffer.join('');
        frameBuffer = [];

        openaiWS.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: joined, // base64 g711_ulaw chunk(s)
          })
        );
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        lastCommit = now;
      }
    }

    if (msg.event === 'stop') {
      console.log('[Twilio] STOP');
      try { openaiWS.close(1000); } catch {}
      try { twilioWS.close(1000); } catch {}
    }
  });

  twilioWS.on('close', () => {
    console.log('[Twilio] WS closed');
    try { openaiWS.close(1000); } catch {}
  });

  twilioWS.on('error', (err) => console.error('[Twilio WS error]', err));
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('////////////////////////////////////////////');
  console.log(`Detected service running on port ${PORT}`);
  console.log('////////////////////////////////////////////');
});
