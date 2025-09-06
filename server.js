import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import morgan from 'morgan';

// ───────────────────────────────────────────────────────────
// Environment
// ───────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const PORT = process.env.PORT || 10000;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in env');
  process.exit(1);
}

// ───────────────────────────────────────────────────────────
// Minimal Express just for health and (optional) TwiML preview
// ───────────────────────────────────────────────────────────
const app = express();
app.use(morgan('dev'));

app.get('/', (_req, res) => res.type('text').send('OK'));

app.get('/voice', (_req, res) => {
  // Optional: for sanity check in a browser
  res.type('xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">Hi! You're through to the Barber A I test. This is the minimal webhook talking. If you hear this, we are good. Now connecting.</Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`
  );
});

// ───────────────────────────────────────────────────────────
// Raw WS (Twilio <Stream>) server on /media
// ───────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Helper: send Twilio a media frame (payload must already be base64 g711_ulaw)
function sendToTwilio(twilioWs, ulawBase64) {
  if (twilioWs.readyState !== twilioWs.OPEN) return;
  const msg = {
    event: 'media',
    media: { payload: ulawBase64 }
  };
  twilioWs.send(JSON.stringify(msg));
}

// Handle Twilio upgrades to /media
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (twilioWs) => {
  const callTag = Math.random().toString(36).slice(2, 6);
  console.log(`[${callTag}] Twilio connected`);

  // 1) Open a WS to OpenAI Realtime
  let openaiWs;
  try {
    openaiWs = new (await import('ws')).default(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );
  } catch (err) {
    console.error(`[${callTag}] Failed to connect to OpenAI WS`, err);
    twilioWs.close();
    return;
  }

  let aiOpen = false;

  // 2) When OpenAI WS opens, immediately ask it to speak (no listening yet)
  openaiWs.on('open', () => {
    aiOpen = true;
    console.log(`[${callTag}] [OpenAI] WS open`);

    // IMPORTANT: valid voice + modalities; ask for audio in g711_ulaw (8k mu-law) so we can forward directly to Twilio
    const create = {
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],   // valid combination
        instructions:
          "You're Barber AI. Greet the caller very briefly. One sentence max.",
        voice: 'alloy',                   // valid OpenAI voice (NOT 'Matthew')
        audio_format: 'g711_ulaw'         // so Twilio can play it without transcoding
      }
    };
    openaiWs.send(JSON.stringify(create));
  });

  // 3) Pipe OpenAI audio deltas to Twilio as media frames
  openaiWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // When the model streams synthesized audio, we receive chunks as base64 deltas
      if (msg.type === 'response.output_audio.delta' && msg.delta) {
        // msg.delta is base64 g711_ulaw because we asked for that format
        sendToTwilio(twilioWs, msg.delta);
      }

      // Optionally close the AI after the first short greeting is done
      if (msg.type === 'response.completed') {
        // After greeting, we simply let the call sit (no more audio).
        // You can also close here:
        // openaiWs.close();
      }
    } catch (e) {
      console.warn(`[${callTag}] [OpenAI] message parse warn`, e);
    }
  });

  openaiWs.on('close', () => {
    console.log(`[${callTag}] [OpenAI] WS closed`);
  });
  openaiWs.on('error', (err) => {
    console.error(`[${callTag}] [OpenAI] error`, err);
  });

  // 4) Handle Twilio side
  twilioWs.on('message', (data) => {
    // We’re intentionally not sending Twilio audio to OpenAI in this minimal “talk-only” build
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'start') {
        console.log(`[${callTag}] [twilio] start`);
      } else if (msg.event === 'media') {
        // ignore inbound audio for now (talk-only)
      } else if (msg.event === 'stop') {
        console.log(`[${callTag}] [twilio] stop`);
      }
    } catch (_) {}
  });

  twilioWs.on('close', () => {
    console.log(`[${callTag}] closed twilio_ws_closed`);
    if (aiOpen) openaiWs.close();
  });

  twilioWs.on('error', (err) => {
    console.error(`[${callTag}] twilio_ws error`, err);
    if (aiOpen) openaiWs.close();
  });
});

// ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Detected service running on port ${PORT}`);
  console.log(`Available at your primary URL https://barber-ai.onrender.com`);
});
