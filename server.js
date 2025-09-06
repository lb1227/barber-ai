import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

/**
 * ENV needed:
 *   OPENAI_API_KEY
 *   OPENAI_REALTIME_MODEL = gpt-4o-realtime-preview-2024-12-17
 *   POLLY_VOICE (optional; OpenAI voices: alloy, verse, breeze, …)
 *
 * TwiML Bin:
 * <Response>
 *   <Say voice="Matthew">Hi! You're through to the Barber A I test. If you hear this, we are good. Now connecting.</Say>
 *   <Connect>
 *     <Stream url="wss://barber-ai.onrender.com/media" />
 *   </Connect>
 * </Response>
 */

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_VOICE = process.env.POLLY_VOICE || 'alloy';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const app = express();

// Optional: simple TwiML check endpoint
app.get('/voice', (req, res) => {
  res.type('text/xml').send(`
<Response>
  <Say voice="Matthew">Hey! You're through to the Barber A I test. This is the minimal webhook talking. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/media' });

// Twilio frames are 20 ms at 8kHz μ-law (160 bytes)
const TWILIO_FRAME_MS = 20;
const COMMIT_MS = 200;
const FRAMES_PER_COMMIT = Math.ceil(COMMIT_MS / TWILIO_FRAME_MS);

function connectOpenAI() {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_MODEL
    )}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function twilioMediaPayload(streamSid, base64ULaw) {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: base64ULaw },
  });
}

wss.on('connection', async (twilioWS) => {
  const tag = Math.random().toString(36).slice(2, 6);
  let streamSid = null;
  let aiWS = null;

  let frameBuffer = [];
  let pendingCommit = false;

  const safeSendTwilio = (msg) => {
    if (twilioWS.readyState === twilioWS.OPEN) twilioWS.send(msg);
  };
  const safeSendAI = (obj) => {
    if (aiWS && aiWS.readyState === aiWS.OPEN) aiWS.send(JSON.stringify(obj));
  };

  const flushFramesToOpenAI = () => {
    if (!frameBuffer.length) return;
    const raw = Buffer.concat(frameBuffer);
    frameBuffer = [];
    const b64 = raw.toString('base64');
    safeSendAI({ type: 'input_audio_buffer.append', audio: b64 });
    safeSendAI({ type: 'input_audio_buffer.commit' });
    pendingCommit = false;
  };

  const cleanup = (why = '') => {
    try { flushFramesToOpenAI(); } catch {}
    try { if (aiWS && aiWS.readyState === aiWS.OPEN) aiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
    console.log(`[${tag}] closed ${why}`);
  };

  // 1) Connect to OpenAI and configure session
  try {
    aiWS = await connectOpenAI();

    safeSendAI({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        modalities: ['text', 'audio'],
        voice: OPENAI_VOICE,
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        instructions:
          'You are a friendly appointment assistant for a barber shop. Keep replies under 2 sentences.',
      },
    });

    // Initial greeting so you hear something immediately
    safeSendAI({
      type: 'response.create',
      response: {
        conversation: 'auto',
        instructions: 'Say: "Hi, this is Barber AI. How can I help you today?"',
        modalities: ['audio'],
      },
    });
  } catch (err) {
    console.error('Failed to connect to OpenAI:', err);
    cleanup('openai_connect_error');
    return;
  }

  // 2) Send OpenAI audio back to Twilio (already g711_ulaw)
  aiWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
      safeSendTwilio(twilioMediaPayload(streamSid, msg.delta));
    }
  });
  aiWS.on('close', () => cleanup('ai_ws_closed'));
  aiWS.on('error', () => cleanup('ai_ws_error'));

  // 3) Handle Twilio Media Stream
  twilioWS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case 'start':
        streamSid = msg.start?.streamSid;
        console.log(`[${tag}] Twilio start sid=${streamSid} format=audio/x-mulaw`);
        break;

      case 'media': {
        const chunk = Buffer.from(msg.media?.payload || '', 'base64');
        if (chunk.length) frameBuffer.push(chunk);
        if (frameBuffer.length >= FRAMES_PER_COMMIT && !pendingCommit) {
          pendingCommit = true;
          flushFramesToOpenAI();
        }
        break;
      }

      case 'stop':
        flushFramesToOpenAI();
        cleanup('twilio_stop');
        break;

      default:
        break;
    }
  });
  twilioWS.on('close', () => cleanup('twilio_ws_closed'));
  twilioWS.on('error', () => cleanup('twilio_ws_error'));
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
});
