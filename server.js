import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

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

// Minimal TwiML test endpoint
app.get('/voice', (req, res) => {
  res.type('text/xml').send(`
<Response>
  <Say voice="Matthew">Hey! You're through to the Barber A I test. This is the minimal webhook talking. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

// Twilio audio details
const TWILIO_FRAME_MS = 20; // 8kHz μ-law -> 20ms = 160 bytes
const COMMIT_MS = 200;      // send to OpenAI each 200ms
const FRAMES_PER_COMMIT = Math.ceil(COMMIT_MS / TWILIO_FRAME_MS);

function connectOpenAI(tag) {
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
    ws.once('open', () => {
      console.log(`[${tag}] [OpenAI] WS open`);
      resolve(ws);
    });
    ws.once('error', (err) => {
      console.error(`[${tag}] [OpenAI] WS error`, err);
      reject(err);
    });
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
  console.log(`[${tag}] Twilio connected`);

  let streamSid = null;
  let aiWS = null;

  let frameBuffer = [];
  let pendingCommit = false;
  let mediaCount = 0;

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
    console.log(`[${tag}] -> OpenAI committed ${(raw.length / 160).toFixed(0)} frames`);
    pendingCommit = false;
  };

  const cleanup = (why = '') => {
    try { flushFramesToOpenAI(); } catch {}
    try { if (aiWS && aiWS.readyState === aiWS.OPEN) aiWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
    console.log(`[${tag}] closed ${why}`);
  };

  // 1) Connect to OpenAI and set the session
  try {
    aiWS = await connectOpenAI(tag);

    // IMPORTANT: Accepted sets are ['text'] or ['audio','text'] (order matters)
    safeSendAI({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        modalities: ['audio', 'text'],
        voice: OPENAI_VOICE,
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        instructions:
          'You are a friendly appointment assistant for a barber shop. Keep replies under 2 sentences.',
      },
    });

    // Initial greeting from OpenAI so you hear something immediately
    safeSendAI({
      type: 'response.create',
      response: {
        // Let OpenAI speak a short greeting
        instructions: 'Say: "Hi, this is Barber AI. How can I help you today?"',
        modalities: ['audio'],
      },
    });
  } catch (err) {
    console.error(`[${tag}] Failed to connect to OpenAI:`, err);
    cleanup('openai_connect_error');
    return;
  }

  // 2) Log everything OpenAI sends; forward audio to Twilio
  aiWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Debug: log non-audio events to catch errors / session results
    if (msg.type !== 'response.audio.delta') {
      if (msg.type === 'error') {
        console.error(`[${tag}] [OpenAI ERROR]`, msg);
      } else {
        // Log only a few common types to avoid spam
        if (['session.updated', 'response.created', 'response.output_text.delta', 'response.completed']
            .includes(msg.type)) {
          console.log(`[${tag}] [OpenAI]`, msg.type);
        }
      }
    }

    if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
      // Already g711_ulaw base64 from OpenAI
      safeSendTwilio(twilioMediaPayload(streamSid, msg.delta));
    }
  });
  aiWS.on('close', () => cleanup('ai_ws_closed'));
  aiWS.on('error', (err) => {
    console.error(`[${tag}] [OpenAI] error`, err);
    cleanup('ai_ws_error');
  });

  // 3) Twilio media stream handler
  twilioWS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case 'start':
        streamSid = msg.start?.streamSid;
        console.log(
          `[${tag}] Twilio START sid=${streamSid} format=${msg.start?.mediaFormat?.encoding || 'unknown'} rate=${msg.start?.mediaFormat?.sampleRate || 'unknown'}`
        );
        break;

      case 'media': {
        mediaCount++;
        if (mediaCount <= 3 || mediaCount % 100 === 0) {
          console.log(`[${tag}] Twilio media frames: ${mediaCount}`);
        }
        const chunk = Buffer.from(msg.media?.payload || '', 'base64');
        if (chunk.length) frameBuffer.push(chunk);
        if (frameBuffer.length >= FRAMES_PER_COMMIT && !pendingCommit) {
          pendingCommit = true;
          flushFramesToOpenAI();
        }
        break;
      }

      case 'stop':
        console.log(`[${tag}] Twilio STOP`);
        flushFramesToOpenAI();
        cleanup('twilio_stop');
        break;

      default:
        break;
    }
  });

  twilioWS.on('close', () => cleanup('twilio_ws_closed'));
  twilioWS.on('error', (err) => {
    console.error(`[${tag}] Twilio WS error`, err);
    cleanup('twilio_ws_error');
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
});
