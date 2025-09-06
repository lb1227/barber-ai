import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

/**
 * ENV you must have in Render (or .env locally):
 * - OPENAI_API_KEY
 * - OPENAI_REALTIME_MODEL = gpt-4o-realtime-preview-2024-12-17
 * - POLLY_VOICE (optional; OpenAI voices: alloy, verse, breeze, etc)
 *
 * Your TwiML Bin should be:
 *
 * <Response>
 *   <Say voice="Matthew">Hi! You're through to the Barber AI test. If you hear this, we are good. Now connecting.</Say>
 *   <Connect>
 *     <Stream url="wss://barber-ai.onrender.com/media" />
 *   </Connect>
 * </Response>
 *
 * (Replace the host with your Render URL if different.)
 */

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_VOICE = process.env.POLLY_VOICE || 'alloy'; // OpenAI voice name

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const app = express();

// Simple “am I up” TwiML (optional)
app.get('/voice', (req, res) => {
  res.type('text/xml').send(`
<Response>
  <Say voice="Matthew">Hey! You're through to the Barber A I test. This is the minimal webhook talking. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

const server = http.createServer(app);

/**
 * Twilio Media Stream <-> OpenAI Realtime bridge
 */
const wss = new WebSocketServer({ server, path: '/media' });

// 20ms per Twilio frame (G.711 μ-law at 8kHz = 160 samples/bytes per frame).
const TWILIO_FRAME_MS = 20;
// Commit at >= 200ms of audio to satisfy OpenAI buffer rule
const COMMIT_MS = 200;
const FRAMES_PER_COMMIT = Math.ceil(COMMIT_MS / TWILIO_FRAME_MS);

/**
 * Utility: make an OpenAI Realtime WS
 */
function connectOpenAI() {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
    const ws = new (await import('ws')).WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * Build TwiML-compatible media JSON to send audio back to Twilio Media Streams
 */
function twilioMediaPayload(streamSid, base64ULaw) {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: base64ULaw }
  });
}

wss.on('connection', async (twilioWS) => {
  let streamSid = null;
  let aiWS = null;

  // buffer of Twilio frames we will push to OpenAI in batches
  let frameBuffer = [];
  let pendingCommit = false;

  // For logging clarity in Render logs
  const tag = Math.random().toString(36).slice(2, 6);

  const safeSendTwilio = (msg) => {
    if (twilioWS.readyState === twilioWS.OPEN) {
      twilioWS.send(msg);
    }
  };

  const safeSendAI = (obj) => {
    if (aiWS && aiWS.readyState === aiWS.OPEN) {
      aiWS.send(JSON.stringify(obj));
    }
  };

  const flushFramesToOpenAI = () => {
    if (!frameBuffer.length) return;
    // Concatenate raw μ-law bytes from all frames
    const raw = Buffer.concat(frameBuffer);
    frameBuffer = [];

    // IMPORTANT: OpenAI expects base64 of the raw bytes
    const b64 = raw.toString('base64');
    safeSendAI({ type: 'input_audio_buffer.append', audio: b64 });

    // Commit at least 200ms each time (we only call flush when we have >= 200ms)
    safeSendAI({ type: 'input_audio_buffer.commit' });
    pendingCommit = false;
  };

  // Tear down everything cleanly
  const cleanup = (why = '') => {
    try {
      flushFramesToOpenAI();
    } catch (e) {}
    if (aiWS && aiWS.readyState === aiWS.OPEN) {
      try { aiWS.close(); } catch (e) {}
    }
    try { twilioWS.close(); } catch (e) {}
    console.log(`[${tag}] closed ${why}`);
  };

  // 1) Connect to OpenAI as soon as Twilio opens
  try {
    aiWS = await connectOpenAI();

    // 1a) Configure OpenAI session for μ-law in/out + audio + text
    safeSendAI({
      type: 'session.update',
      session: {
        // “g711_ulaw” matches Twilio (audio/x-mulaw at 8kHz)
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        modalities: ['text', 'audio'],
        voice: OPENAI_VOICE,
        // Optional: server-side VAD to auto detect end of user turns
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        instructions:
          'You are a friendly appointment assistant for a barber shop. Keep replies under 2 sentences.'
      }
    });

    // 1b) Create an initial response so we *hear something* immediately
    safeSendAI({
      type: 'response.create',
      response: {
        conversation: 'auto',
        instructions:
          'Say: "Hi, this is Barber AI. How can I help you today?"',
        modalities: ['audio'] // ensures an audio greeting is produced
      }
    });
  } catch (err) {
    console.error('Failed to connect to OpenAI:', err);
    cleanup('openai_connect_error');
    return;
  }

  // 2) Route OpenAI audio back to Twilio
  aiWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Debug minimal
    if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
      // msg.delta is base64 μ-law when output_audio_format=g711_ulaw
      safeSendTwilio(twilioMediaPayload(streamSid, msg.delta));
    }

    // Optional: you can inspect other message types for debugging
    // e.g. response.completed, response.created, error, etc.
  });

  aiWS.on('close', () => cleanup('ai_ws_closed'));
  aiWS.on('error', () => cleanup('ai_ws_error'));

  // 3) Handle Twilio Media Stream messages
  twilioWS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case 'connected':
        // nothing
        break;

      case 'start':
        streamSid = msg.start?.streamSid;
        console.log(`[${tag}] Twilio start sid=${streamSid} format=audio/x-mulaw`);
        break;

      case 'media':
        // Twilio payload is base64 μ-law. We push raw bytes to a frame buffer.
        if (!msg.media?.payload) return;
        const chunk = Buffer.from(msg.media.payload, 'base64');
        frameBuffer.push(chunk);

        // When we have >=200ms, flush+commit to OpenAI
        if (frameBuffer.length >= FRAMES_PER_COMMIT && !pendingCommit) {
          pendingCommit = true;
          flushFramesToOpenAI();
        }
        break;

      case 'stop':
        console.log(`[${tag}] Twilio stop`);
        // Let OpenAI know we’re done with current turn (flush if any)
        flushFramesToOpenAI();
        cleanup('twilio_stop');
        break;

      default:
        // ignore
        break;
    }
  });

  twilioWS.on('close', () => cleanup('twilio_ws_closed'));
  twilioWS.on('error', () => cleanup('twilio_ws_error'));
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
});
