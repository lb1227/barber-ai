/**
 * Minimal Twilio <-> OpenAI Realtime bridge
 * - Twilio sends 8kHz μ-law audio frames over a WebSocket
 * - We forward frames to OpenAI Realtime and COMMIT every ~200ms
 * - We forward OpenAI output_audio_buffer.append frames back to Twilio
 *
 * ENV needed:
 *   PORT                      (optional; default 10000 on Render)
 *   OPENAI_API_KEY            (required)
 *   OPENAI_REALTIME_MODEL     (e.g. gpt-4o-realtime-preview-2024-12-17)
 *
 * TwiML example to enable bidi media stream:
 * <Response>
 *   <Connect>
 *     <Stream url="wss://YOUR-APP.onrender.com/media" />
 *   </Connect>
 * </Response>
 */

require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws'); // OpenAI side
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY env var.');
  process.exit(1);
}

const app = express();
expressWs(app);
app.use(bodyParser.json());

/** Just a health check */
app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

/**
 * Twilio <Stream> WebSocket endpoint
 * Twilio connects here (wss://.../media)
 */
app.ws('/media', (twilioWs, req) => {
  const callTag = randomTag();
  info(callTag, 'Twilio connected');

  let streamSid = null;

  // ---- OpenAI Realtime WebSocket ----
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_REALTIME_MODEL
  )}`;

  const oaWs = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // inbound batching (from Twilio -> OpenAI)
  let pendingFrames = 0; // number of 20ms frames collected since last commit
  const COMMIT_EVERY_FRAMES = 10; // 10 * 20ms = 200ms

  // ---- Twilio incoming messages ----
  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'connected') {
        info(callTag, 'Twilio event: connected');
      }

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        info(callTag, 'Call started', {
          accountSid: msg.start.accountSid,
          streamSid,
          format: msg.start.mediaFormat,
        });
      }

      if (msg.event === 'media') {
        // Each media event is 20ms of μ-law audio at 8kHz
        // Forward to OpenAI as input_audio_buffer.append
        if (oaWs && oaWs.readyState === WebSocket.OPEN) {
          oaWs.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload, // base64 μ-law
            })
          );
          pendingFrames += 1;

          // Only COMMIT after enough audio is queued (≥ ~100ms; we use 200ms to be safe)
          if (pendingFrames >= COMMIT_EVERY_FRAMES) {
            oaWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            pendingFrames = 0;
          }
        }
      }

      if (msg.event === 'stop') {
        info(callTag, 'Twilio event: stop (hangup)');
        try {
          twilioWs.close();
        } catch {}
      }
    } catch (e) {
      error(callTag, 'Twilio msg parse error', e);
    }
  });

  twilioWs.on('close', () => {
    info(callTag, 'Twilio socket closed');
    try {
      oaWs.close();
    } catch {}
  });

  twilioWs.on('error', (e) => error(callTag, 'Twilio WS error', e));

  // ---- OpenAI WebSocket lifecycle ----
  oaWs.on('open', () => {
    info(callTag, '[OpenAI] WS open');

    // 1) Configure the session: modalities must be ["audio","text"]
    //    and the audio format must match Twilio: 8kHz μ-law mono.
    oaWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          input_audio_format: {
            type: 'g711_ulaw',
            sample_rate: 8000,
            channels: 1,
          },
          output_audio_format: {
            type: 'g711_ulaw',
            sample_rate: 8000,
            channels: 1,
          },
          // Keep it simple: no extra/unknown fields
          voice: 'alloy', // any supported voice
        },
      })
    );

    // 2) Immediately create a response so the caller hears something
    oaWs.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio'],
          instructions:
            'Hello! You are connected. I can hear you. How can I help?',
        },
      })
    );
  });

  oaWs.on('message', (raw) => {
    // OpenAI Realtime sends newline-delimited JSON
    const text = raw.toString();
    const parts = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const line of parts) {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        // Some frames can be non-JSON (rare). Ignore quietly.
        continue;
      }

      const t = evt.type;

      // Play TTS audio from OpenAI -> Twilio
      if (t === 'output_audio_buffer.append' && evt.audio) {
        if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: 'media',
              media: { payload: evt.audio }, // base64 μ-law
            })
          );
        }
      }

      // When a chunk is fully synthesized, mark complete
      if (t === 'output_audio_buffer.commit') {
        // Nothing to send to Twilio here; commit is internal to Realtime
      }

      // Useful error visibility
      if (evt.type === 'error') {
        error(callTag, '[OpenAI ERROR]', evt);
      }
    }
  });

  oaWs.on('close', (code, reason) => {
    info(callTag, `[OpenAI] WS closed ${code} ${reason || ''}`);
    try {
      twilioWs.close();
    } catch {}
  });

  oaWs.on('error', (e) => error(callTag, '[OpenAI] WS error', e));
});

// ----------------- server bootstrap -----------------
app.listen(PORT, () => {
  info('', `Service live on port ${PORT}`);
});

// ----------------- helpers -----------------
function info(tag, msg, obj) {
  const p = tag ? `${tag}` : '';
  console.log(`${stamp()}  INFO  ${p} ${msg}`, obj ? obj : '');
}
function error(tag, msg, obj) {
  const p = tag ? `${tag}` : '';
  console.error(`${stamp()} ERROR  ${p} ${msg}`, obj ? obj : '');
}
function stamp() {
  return new Date().toISOString();
}
function randomTag() {
  return Math.random().toString(36).slice(2, 7);
}
