// src/server.js  (CommonJS)
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// health + Twilio status endpoints (optional)
app.get('/', (_req, res) => res.send('OK'));
app.post('/twilio-status', (_req, res) => res.sendStatus(200));

// Create HTTP server and attach WS server for /media
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ---- Utilities --------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

// Send to Twilio Media Streams
function sendTwilio(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Send to OpenAI Realtime
function sendOpenAI(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ---- Bridge session per call -----------------------------------------------

wss.on('connection', (twilioWs, request) => {
  const callId = Math.random().toString(36).slice(2, 10);

  console.log(`[${now()}] [call ${callId}] Twilio WS connected`);

  // 1) Connect to OpenAI Realtime WS (μ-law passthrough)
  const oaWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  let streamSid = null;
  let frameBuffer = [];           // store raw base64 μ-law frames from Twilio
  let bufferTimer = null;
  const COMMIT_INTERVAL_MS = 200; // 10 x 20ms frames = 200ms

  function startCommitLoop() {
    if (bufferTimer) return;
    bufferTimer = setInterval(() => {
      if (frameBuffer.length === 0) return; // avoid commit_empty
      // Append all frames collected to OpenAI
      for (const payload of frameBuffer) {
        sendOpenAI(oaWs, {
          type: 'input_audio_buffer.append',
          // Twilio payload is base64 μ-law 8k mono; Realtime accepts same
          audio: payload,
        });
      }
      frameBuffer = [];
      // Now commit the appended audio chunk
      sendOpenAI(oaWs, { type: 'input_audio_buffer.commit' });
    }, COMMIT_INTERVAL_MS);
  }

  function stopCommitLoop() {
    if (bufferTimer) {
      clearInterval(bufferTimer);
      bufferTimer = null;
    }
  }

  // ---- OpenAI WS events ----------------------------------------------------

  oaWs.on('open', () => {
    console.log(`[${now()}] [call ${callId}] OpenAI WS open`);

    // Configure session correctly (fixes: unknown/invalid params)
    sendOpenAI(oaWs, {
      type: 'session.update',
      session: {
        // Tell OpenAI the inbound audio we will append is μ-law:
        input_audio_format: 'g711_ulaw',
        // Ask OpenAI to speak back in μ-law so we can feed Twilio directly:
        response: {
          modalities: ['text', 'audio'],
          conversation: 'auto', // 'auto' or 'none'
          audio: {
            voice: 'alloy',     // any supported voice
            format: 'g711_ulaw' // match Twilio, no transcoding
          }
        }
      }
    });

    // Optional greeting and to ensure the model starts producing audio
    sendOpenAI(oaWs, {
      type: 'response.create',
      response: {
        instructions:
          "You're Barber AI. Greet the caller and ask how you can help. Keep it concise and friendly."
      }
    });
  });

  oaWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Stream back OpenAI audio (already μ-law base64) to Twilio
      if (msg.type === 'response.output_audio.delta' && msg.delta) {
        sendTwilio(twilioWs, {
          event: 'media',
          media: { payload: msg.delta }
        });
      }

      // Helpful logs for debugging
      if (msg.type === 'response.completed') {
        console.log(`[${now()}] [call ${callId}] OpenAI response completed`);
      }
      if (msg.type === 'error') {
        console.error(`[${now()}] [call ${callId}] OpenAI ERROR:`, msg);
      }
    } catch (e) {
      console.error(`[${now()}] [call ${callId}] OpenAI parse error`, e);
    }
  });

  oaWs.on('close', () => {
    console.log(`[${now()}] [call ${callId}] OpenAI WS closed`);
    stopCommitLoop();
    try { twilioWs.close(); } catch {}
  });

  oaWs.on('error', (err) => {
    console.error(`[${now()}] [call ${callId}] OpenAI WS error`, err);
  });

  // ---- Twilio WS events ----------------------------------------------------

  twilioWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case 'start':
        streamSid = msg.start?.streamSid || streamSid;
        console.log(
          `[${now()}] [call ${callId}] Twilio START streamSid=${streamSid} format=${msg.start?.mediaFormat?.encoding}`
        );
        // Twilio started; begin our commit timer
        startCommitLoop();
        break;

      case 'media':
        // Collect each 20ms μ-law frame into the buffer
        if (msg.media?.payload) {
          frameBuffer.push(msg.media.payload);
        }
        break;

      case 'mark':
      case 'stop':
        console.log(`[${now()}] [call ${callId}] Twilio ${msg.event}`);
        break;

      default:
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log(`[${now()}] [call ${callId}] Twilio WS closed`);
    stopCommitLoop();
    try { oaWs.close(); } catch {}
  });

  twilioWs.on('error', (err) => {
    console.error(`[${now()}] [call ${callId}] Twilio WS error`, err);
  });
});

// HTTP Upgrade only for /media
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
  console.log(`Available at your primary URL https://barber-ai.onrender.com`);
});
