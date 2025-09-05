// server.js — Twilio <-> OpenAI Realtime
// Adds: robust logging, Realtime retry, don't drop Twilio immediately, μ-law 8kHz both ways, server VAD, guaranteed audio responses

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { WebSocketServer } from 'ws';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

// ---- small helpers ----
const ULawSilenceByte = 0xFF;            // μ-law silence
const SILENCE_FRAME_MS = 20;             // Twilio media frame is 20 ms
const SAMPLE_RATE = 8000;                // μ-law sample rate
const BYTES_PER_MS = SAMPLE_RATE / 1000; // 8 bytes/ms in μ-law (1 byte/sample @ 8 kHz)
function base64Silence(ms = SILENCE_FRAME_MS) {
  const bytes = Buffer.alloc(ms * BYTES_PER_MS, ULawSilenceByte);
  return bytes.toString('base64');
}

function now() {
  return new Date().toISOString();
}

function makeQueuedSender(ws) {
  let open = false;
  const q = [];
  ws.on('open', () => {
    open = true;
    while (q.length) ws.send(q.shift());
  });
  return (payload) => {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (open) ws.send(s);
    else q.push(s);
  };
}

// ---------- HTTP routes ----------
app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice-say', (_req, res) => {
  const twiml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">This is the test route. Your webhook is working.</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

app.post('/voice', (req, res) => {
  const url = `wss://${req.headers.host}/twilio`;
  const from = (req.body?.From || '').replace(/"/g, '');
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${url}">
          <Parameter name="from" value="${from}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// ---------- WS bridge ----------
const wss = new WebSocketServer({ noServer: true });
const server = app.listen(PORT, () => console.log(`[${now()}] Server listening on ${PORT}`));

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', async (twilioWS) => {
  let rt;
  let sendRT;
  let sawAudioDelta = false;
  let retryCount = 0;
  let closed = false;

  console.log(`[${now()}] Twilio WS open`);

  // optional: send a couple of silence frames while we spin up Realtime to prevent Twilio from dropping
  for (let i = 0; i < 3; i++) {
    try {
      twilioWS.send(JSON.stringify({ event: 'media', media: { payload: base64Silence() } }));
    } catch {}
  }

  async function connectRealtime() {
    return new Promise(async (resolve) => {
      rt = new (await import('ws')).WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1',
          },
        }
      );

      sendRT = makeQueuedSender(rt);

      rt.on('open', () => {
        console.log(`[${now()}] Realtime WS open`);
        // Force μ-law in/out 8kHz, server VAD, and set instructions.
        sendRT({
          type: 'session.update',
          session: {
            input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            turn_detection: { type: 'server_vad', threshold: 0.5, silence_ms: 700 },
            voice: 'verse',
            instructions:
              'You are a friendly barber shop phone agent. Always reply in speech (audio). Keep answers brief and natural.',
          },
        });

        // Proactive greeting, requesting audio explicitly
        sendRT({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            audio: { format: 'g711_ulaw', voice: 'verse' },
            instructions: 'Hello, thank you for calling XYZ barbershop. How can I help you today?',
          },
        });

        resolve(true);
      });

      rt.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // useful trace
          if (
            msg.type?.startsWith('response.') ||
            msg.type?.startsWith('input_audio_buffer.') ||
            msg.type === 'session.created' ||
            msg.type === 'session.updated'
          ) {
            console.log(`[${now()}] Realtime event: ${msg.type}`);
          }

          // when the user stops talking, commit and request a response
          if (msg.type === 'input_audio_buffer.speech_stopped') {
            sendRT({ type: 'input_audio_buffer.commit' });
            sendRT({
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                audio: { format: 'g711_ulaw', voice: 'verse' },
              },
            });
          }

          // stream audio back to Twilio — cover both event names
          if (
            (msg.type === 'response.audio.delta' && msg.audio) ||
            (msg.type === 'response.output_audio.delta' && msg.audio)
          ) {
            sawAudioDelta = true;
            twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
          }

          // log text deltas (debug)
          if (msg.type === 'response.delta' && msg.delta) {
            console.log(`[${now()}] Text delta: ${JSON.stringify(msg.delta)}`);
          }

          if (msg.type === 'response.created') sawAudioDelta = false;
          if (msg.type === 'response.done' && !sawAudioDelta) {
            console.log(`[${now()}] response.done but no audio deltas were received for this turn.`);
          }
        } catch (e) {
          console.error(`[${now()}] Realtime msg parse error:`, e);
        }
      });

      rt.on('error', (e) => {
        console.error(`[${now()}] Realtime WS error:`, e?.message || e);
      });

      rt.on('close', (code, reason) => {
        console.error(
          `[${now()}] Realtime closed. code=${code}, reason=${reason?.toString?.() || ''} retry=${retryCount}`
        );

        // Retry once if it closed very early (e.g. auth / handshake hiccup)
        if (!closed && retryCount < 1) {
          retryCount += 1;
          setTimeout(() => {
            console.log(`[${now()}] Retrying Realtime connection...`);
            connectRealtime().then(() => resolve(true));
          }, 400);
        } else {
          resolve(false);
        }
      });
    });
  }

  const connected = await connectRealtime();

  if (!connected) {
    console.error(`[${now()}] Realtime failed; keeping Twilio alive briefly then ending.`);
    try {
      // keep 1 second of silence so call doesn't feel abrupt
      for (let i = 0; i < 50; i++) {
        twilioWS.send(JSON.stringify({ event: 'media', media: { payload: base64Silence() } }));
      }
    } catch {}
    try { twilioWS.close(); } catch {}
    return;
  }

  // ----- Twilio -> Realtime -----
  twilioWS.on('message', (buf) => {
    try {
      const evt = JSON.parse(buf.toString());
      switch (evt.event) {
        case 'start':
          console.log(`[${now()}] Twilio start, from:`, evt?.start?.customParameters?.from);
          break;
        case 'media': {
          const ulaw = evt.media?.payload;
          if (ulaw) sendRT({ type: 'input_audio_buffer.append', audio: ulaw });
          break;
        }
        case 'stop':
          console.log(`[${now()}] Twilio stop`);
          sendRT({ type: 'input_audio_buffer.commit' });
          try { rt.close(); } catch {}
          try { twilioWS.close(); } catch {}
          break;
      }
    } catch (e) {
      console.error(`[${now()}] Twilio msg parse error:`, e);
    }
  });

  twilioWS.on('close', () => {
    console.log(`[${now()}] Twilio WS closed`);
    closed = true;
    try { rt?.close(); } catch {}
  });

  twilioWS.on('error', (e) => {
    console.error(`[${now()}] Twilio WS error:`, e?.message || e);
    closed = true;
    try { rt?.close(); } catch {}
  });
});
