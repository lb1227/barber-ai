// server.js — Twilio <-> OpenAI Realtime (μ-law) with safe audio buffering
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
// Twilio entry: connect media stream to our WS endpoint
// ────────────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`.trim();
  res.type('text/xml').send(twiml);
});

// Simple health
app.get('/health', (_req, res) => res.send('ok'));

// ────────────────────────────────────────────────────────────
// WS bridge Twilio <-> OpenAI Realtime
// ────────────────────────────────────────────────────────────
const server = app.listen(PORT, () =>
  console.log('Server listening on', PORT)
);

const wss = new WebSocketServer({ noServer: true });

// Allow only /twilio
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Helpers
const log = (...a) => console.log(new Date().toISOString(), ...a);

// μ-law @ 8kHz: 1 byte/sample => 100ms ≈ 800 bytes
const MIN_COMMIT_BYTES = 800;

// ────────────────────────────────────────────────────────────
wss.on('connection', async (twilioWS, req) => {
  log('Twilio WS open');

  // Connect to OpenAI Realtime
  const openaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;

  const rt = new (await import('ws')).WebSocket(openaiURL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // Track how much audio we appended since last commit
  let appendedBytesSinceCommit = 0;
  let appendedSinceLastCommit = false;

  // Forward OpenAI audio deltas back to Twilio as media frames
  rt.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'response.audio.delta' && msg.audio) {
        // Send μ-law payload back to Twilio
        const frame = JSON.stringify({
          event: 'media',
          media: { payload: msg.audio },
        });
        twilioWS.send(frame);
      }

      // Helpful logs
      if (msg.type === 'response.created') {
        log('Realtime event: response.created');
      } else if (msg.type === 'response.done') {
        log('Realtime event: response.done');
      } else if (msg.type === 'input_audio_buffer.speech_started') {
        log('Realtime event: input_audio_buffer.speech_started');
      } else if (msg.type === 'input_audio_buffer.speech_stopped') {
        log('Realtime event: input_audio_buffer.speech_stopped');
      } else if (msg.type === 'error') {
        log('Realtime ERROR payload:', JSON.stringify(msg, null, 2));
      }
    } catch (_e) {
      // ignore
    }
  });

  rt.on('open', () => {
    log('Realtime WS open');

    // Configure session: exact formats Twilio is sending/expecting
    rt.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          // OpenAI VAD runs when you append audio; we specify formats explicitly
          input_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
          output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
          // optional: bias to speak
          instructions:
            'You are a friendly phone receptionist. Be concise and speak naturally.',
        },
      })
    );

    // Initial greeting
    rt.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'], // valid combos
          instructions:
            'Hello! Thanks for calling. How can I help you today?',
        },
      })
    );
  });

  rt.on('close', () => {
    log('Realtime closed');
    try {
      twilioWS.close();
    } catch {}
  });

  rt.on('error', (e) => {
    log('Realtime error:', e?.message || e);
    try {
      twilioWS.close();
    } catch {}
  });

  // Receive audio frames from Twilio and feed them to OpenAI
  twilioWS.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      if (evt.event === 'start') {
        log('Twilio start');
        appendedBytesSinceCommit = 0;
        appendedSinceLastCommit = false;
        return;
      }

      if (evt.event === 'media' && evt.media?.payload) {
        // Append audio (μ-law base64)
        rt.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: evt.media.payload,
          })
        );

        appendedSinceLastCommit = true;
        // Count raw bytes
        appendedBytesSinceCommit += Buffer.from(
          evt.media.payload,
          'base64'
        ).length;

        // If we’ve reached at least 100ms, commit + request response
        if (appendedBytesSinceCommit >= MIN_COMMIT_BYTES) {
          rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

          rt.send(
            JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['text', 'audio'],
                instructions: '', // ask the model to respond to the latest user speech
              },
            })
          );

          appendedBytesSinceCommit = 0;
          appendedSinceLastCommit = false;
        }
        return;
      }

      if (evt.event === 'stop') {
        log('Twilio stop');

        // Final flush if we appended but didn’t reach threshold
        if (appendedSinceLastCommit) {
          rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          rt.send(
            JSON.stringify({
              type: 'response.create',
              response: { modalities: ['text', 'audio'], instructions: '' },
            })
          );
        }

        try {
          rt.close();
        } catch {}
        try {
          twilioWS.close();
        } catch {}
        return;
      }
    } catch (e) {
      log('Twilio WS parse error:', e?.message || e);
    }
  });

  twilioWS.on('close', () => {
    log('Twilio WS closed');
    try {
      rt.close();
    } catch {}
  });

  twilioWS.on('error', () => {
    try {
      rt.close();
    } catch {}
  });
});
