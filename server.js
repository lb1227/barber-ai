// server.js — Twilio <-> OpenAI Realtime (μ-law), server VAD, no per-frame commit

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

// Simple health check
app.get('/health', (_req, res) => res.send('ok'));

// Twilio entry: stream media to our WS
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

    let sessionReady = false;

    // Realtime -> Twilio: play audio deltas back to the caller
    rt.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      if (msg.type === 'error' || msg.error) {
        console.error('Realtime ERROR payload:', JSON.stringify(msg, null, 2));
        return;
      }

      // Helpful logging of event types
      if (msg?.type) {
        console.log('Realtime event:', msg.type);
      }

      // Current and legacy audio delta event names
      const isAudioDelta =
        msg?.type === 'response.output_audio.delta' ||
        msg?.type === 'response.audio.delta' ||
        msg?.type === 'response.speech.delta';

      if (isAudioDelta) {
        // Different previews used different fields for the base64 μ-law chunk
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
    });

    rt.on('open', () => {
      console.log('Realtime WS open');

      // Configure session for μ-law in/out + server VAD
      rt.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            input_audio_format: { type: 'g711_ulaw' },   // Twilio μ-law input
            output_audio_format: { type: 'g711_ulaw' },  // μ-law back to Twilio
            voice: 'verse',
            // Let the server detect end-of-speech; we will NOT send commit each frame
            turn_detection: {
              type: 'server_vad',
              // optional tunables:
              // threshold: 0.5,
              // prefix_padding_ms: 300,
              // silence_duration_ms: 300
            },
            instructions:
              'You are a friendly, concise phone receptionist for XYZ barbershop. Speak naturally.',
          },
        })
      );

      // Immediate spoken greeting
      rt.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['audio'],
            instructions:
              'Hello, thank you for calling XYZ barbershop, how can I help you today?',
          },
        })
      );

      sessionReady = true;
    });

    rt.on('error', (e) => {
      console.error('Realtime socket error:', e?.message || e);
      try { twilioWS.close(); } catch {}
    });

    rt.on('close', () => {
      console.log('Realtime closed');
      try { twilioWS.close(); } catch {}
    });

    // Twilio -> Realtime: only append audio; DO NOT commit when using server VAD
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

      if (evt.event === 'media') {
        if (!sessionReady) return;
        // Append caller audio chunk (base64 μ-law)
        rt.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: evt.media.payload,
          })
        );
        // ❌ Do NOT send input_audio_buffer.commit here when using server_vad
        return;
      }

      if (evt.event === 'stop') {
        console.log('Twilio stop');
        try { rt.close(); } catch {}
        try { twilioWS.close(); } catch {}
      }
    });

    twilioWS.on('close', () => {
      console.log('Twilio WS closed');
      try { rt.close(); } catch {}
    });

    twilioWS.on('error', () => {
      try { rt.close(); } catch {}
    });
  });

  return wss;
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log('Listening on', PORT));
ensureWSS(server);