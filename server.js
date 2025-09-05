// server.js — Twilio <-> OpenAI Realtime (μ-law in/out), with robust audio return

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

const BUSINESS_NAME = 'XYZ barbershop';
const TZ = process.env.TZ || 'America/New_York';

/* ---------------- Twilio entry: start media stream ---------------- */
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${(req.body.From || '').replace(/"/g, '')}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

/* ---- tiny health check (useful in Render to test instance) ---- */
app.get('/health', (_req, res) => res.send('ok'));

/* ------------ WebSocket bridge: Twilio <-> OpenAI Realtime ------------ */
let wss;
function ensureWSS(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/twilio')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (twilioWS) => {
    // Connect to OpenAI Realtime
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      REALTIME_MODEL
    )}`;

    const rt = new (await import('ws')).WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let started = false;

    /* ---------- Realtime -> Twilio: forward audio deltas ---------- */
    rt.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // Log everything (super helpful to see exactly what events you receive)
      if (msg?.type) {
        console.log('Realtime event:', msg.type);
      }

      // Handle *any* of the known audio delta event names
      const isAudioDelta =
        msg?.type === 'response.output_audio.delta' ||
        msg?.type === 'response.audio.delta' ||
        msg?.type === 'response.speech.delta';

      if (isAudioDelta) {
        // Different previews used 'delta', 'audio', or 'chunk' for the base64 payload
        const payload = msg.delta || msg.audio || msg.chunk;
        if (payload) {
          twilioWS.send(
            JSON.stringify({
              event: 'media',
              media: { payload },
            })
          );
        }
      }

      // When a response completely finishes, you *could* queue the next one, etc.
      // For this use-case we just let the conversation flow based on VAD and user input.
    });

    rt.on('open', () => {
      console.log('Realtime WS open');

      // Configure session: μ-law both ways, simple VAD, and prompt
      rt.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            // Twilio sends μ-law; ask the model to expect μ-law
            input_audio_format: { type: 'g711_ulaw' },
            // and return μ-law back to us
            output_audio_format: { type: 'g711_ulaw' },

            // Optional voice; the Realtime service will TTS for us
            voice: 'verse',

            // Simple VAD so you don't have to do manual "commit" timing:
            turn_detection: { type: 'server_vad' },

            instructions: `
You are a warm, efficient phone receptionist for ${BUSINESS_NAME}.
Always speak concisely and naturally. Use tool calls when needed, but for now
just have a friendly conversation. Time zone: ${TZ}.
            `.trim(),
          },
        })
      );

      // Send an immediate spoken greeting
      rt.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['audio'], // important: ask for audio
            instructions:
              'Hello, thank you for calling XYZ barbershop, how can I help you today?',
          },
        })
      );

      started = true;
    });

    rt.on('close', () => {
      console.log('Realtime closed');
      try {
        twilioWS.close();
      } catch {}
    });
    rt.on('error', (e) => {
      console.error('Realtime error', e?.message || e);
      try {
        twilioWS.close();
      } catch {}
    });

    /* ---------- Twilio -> Realtime: forward caller audio ---------- */
    twilioWS.on('message', (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (evt.event === 'start') {
        console.log('Twilio start');
        return;
      }

      if (evt.event === 'media' && started) {
        // Caller audio in base64 μ-law -> append to input buffer
        rt.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: evt.media.payload,
          })
        );

        // With server VAD on, we can periodically ask the model to process what it has
        // (If you prefer manual control, you can gate "commit" on silence or timers.)
        rt.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        return;
      }

      if (evt.event === 'stop') {
        console.log('Twilio stop');
        try {
          rt.close();
        } catch {}
        try {
          twilioWS.close();
        } catch {}
      }
    });

    twilioWS.on('close', () => {
      console.log('Twilio WS closed');
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

  return wss;
}

/* ---------------- boot ---------------- */
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('Listening on', PORT);
});
ensureWSS(server);
