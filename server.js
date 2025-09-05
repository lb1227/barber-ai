// server.js — Twilio <-> OpenAI Realtime (g711 μ-law) + basic REST + health
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ------------------------------ CONFIG ------------------------------ */
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// Twilio Media Streams: 8 kHz, μ-law, 20 ms per frame
const TWILIO_AUDIO_FORMAT = 'g711_ulaw';
const TWILIO_FRAMES_PER_COMMIT = 5; // 5 × 20ms = 100ms

/* ------------------------------ HTTP ------------------------------ */

// Twilio webhook that starts the bidirectional stream
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const from = (req.body?.From || '').replace(/"/g, '');

  const twiml = `
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="from" value="${from}"/>
    </Stream>
  </Connect>
</Response>
`.trim();

  res.type('text/xml').send(twiml);
});

// Quick “say a line” test (verifies Twilio ↔︎ you only)
app.get('/voice-say', (_req, res) => {
  const twiml = `
<Response>
  <Say voice="Polly.Matthew-Neural">Your Twilio voice path is good.</Say>
  <Hangup/>
</Response>`.trim();
  res.type('text/xml').send(twiml);
});

app.get('/health', (_req, res) => res.send('ok'));

/* --------------------------- WebSocket bridge --------------------------- */

let wss;

/**
 * Create a WSS that upgrades only /twilio and then bridges Twilio <=> OpenAI
 */
function ensureWSS(server) {
  if (wss) return wss;

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/twilio')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (twilioWS, req) => {
    const caller = new URL(req.url, 'http://x/').searchParams.get('from') || '';

    // Create OpenAI Realtime WS
    const oaURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      REALTIME_MODEL
    )}`;

    const oa = new WebSocket(oaURL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let framesSinceCommit = 0;
    let openaiReady = false;

    /* ------------ OpenAI events → Twilio (play audio to caller) ------------ */
    oa.on('open', () => {
      console.log('OpenAI WS open');

      // Tell OpenAI what audio we will SEND (from the caller)
      // IMPORTANT: string 'g711_ulaw', not an object
      oa.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            input_audio_format: TWILIO_AUDIO_FORMAT, // << fix #1
          },
        })
      );

      // Send greeting and ask OpenAI to reply with audio + text
      oa.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'], // << fix #2
            instructions:
              'You are the friendly receptionist for XYZ Barbershop. Greet the caller and ask how you can help.',
            audio: {
              // return μ-law so we can stream straight to Twilio
              format: TWILIO_AUDIO_FORMAT,
              voice: 'verse',
            },
          },
        })
      );

      openaiReady = true;
    });

    oa.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Streaming audio data to Twilio
        if (msg.type === 'response.audio.delta' && msg.audio) {
          twilioWS.send(
            JSON.stringify({ event: 'media', media: { payload: msg.audio } })
          );
        }

        // Optional: log helpful things
        if (msg.type?.startsWith('error')) {
          console.error('Realtime ERROR payload:', msg);
        }
        if (msg.type === 'session.updated') {
          console.log('Realtime event: session.updated');
        }
      } catch (e) {
        // Just ignore parse errors
      }
    });

    oa.on('close', () => {
      try {
        twilioWS.close();
      } catch {}
    });
    oa.on('error', (err) => {
      console.error('OpenAI WS error:', err?.message || err);
      try {
        twilioWS.close();
      } catch {}
    });

    /* ------------- Twilio events → OpenAI (send caller audio) ------------- */
    twilioWS.on('message', (raw) => {
      if (oa.readyState !== WebSocket.OPEN) return;

      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (evt.event) {
        case 'start': {
          console.log('Twilio stream connected. From:', evt?.start?.customParameters?.from || '');
          break;
        }
        case 'media': {
          // forward 20ms μ-law base64; only COMMIT after ≥5 frames (≥100ms)
          oa.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: evt.media.payload,
            })
          );
          framesSinceCommit += 1;

          if (framesSinceCommit >= TWILIO_FRAMES_PER_COMMIT) {
            oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); // << fix #3
            framesSinceCommit = 0;

            // Ask for a response after each ~100ms chunk (keeps latency low)
            if (openaiReady) {
              oa.send(
                JSON.stringify({
                  type: 'response.create',
                  response: {
                    modalities: ['text', 'audio'],
                    audio: { format: TWILIO_AUDIO_FORMAT, voice: 'verse' },
                  },
                })
              );
            }
          }
          break;
        }
        case 'mark':
          // ignore
          break;
        case 'stop': {
          // Final commit on hangup
          oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          try {
            oa.close();
          } catch {}
          try {
            twilioWS.close();
          } catch {}
          break;
        }
      }
    });

    twilioWS.on('close', () => {
      try {
        oa.close();
      } catch {}
    });
    twilioWS.on('error', () => {
      try {
        oa.close();
      } catch {}
    });
  });

  return wss;
}

/* ------------------------------- START ------------------------------- */

const server = app.listen(PORT, () =>
  console.log('Server listening on', PORT)
);
ensureWSS(server);
