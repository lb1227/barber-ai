// server.js — Twilio <-> OpenAI Realtime (μ-law 8kHz, server VAD)
// Fix: input_audio_format/output_audio_format must be STRINGS (not objects).
// Adds: log ALL incoming Realtime messages; keep Twilio up briefly on failure.

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

// ---- helpers ----
const ULawSilenceByte = 0xFF;
const SILENCE_FRAME_MS = 20;
const SAMPLE_RATE = 8000; // μ-law 8kHz
const BYTES_PER_MS = SAMPLE_RATE / 1000;

function base64Silence(ms = SILENCE_FRAME_MS) {
  const bytes = Buffer.alloc(ms * BYTES_PER_MS, ULawSilenceByte);
  return bytes.toString('base64');
}
const now = () => new Date().toISOString();

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

// ---- routes ----
app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice-say', (_req, res) => {
  const twiml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">Webhook test speaking. This confirms your TwiML URL is working.</Say>
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

// ---- WS bridge ----
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

  // keep Twilio alive while we spin up Realtime
  try {
    for (let i = 0; i < 3; i++) {
      twilioWS.send(JSON.stringify({ event: 'media', media: { payload: base64Silence() } }));
    }
  } catch {}

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
        // IMPORTANT: formats must be strings
        sendRT({
          type: 'session.update',
          session: {
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            turn_detection: { type: 'server_vad', threshold: 0.5, silence_ms: 700 },
            voice: 'verse',
            instructions:
              'You are a friendly barber shop phone agent. Always reply in speech (audio). Keep answers brief and natural.',
          },
        });

        // initial greeting — request audio explicitly
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

      // LOG EVERYTHING so we can see errors
      rt.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          console.log(`[${now()}] Realtime msg:`, msg.type || msg);

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

          if (
            (msg.type === 'response.audio.delta' && msg.audio) ||
            (msg.type === 'response.output_audio.delta' && msg.audio)
          ) {
            sawAudioDelta = true;
            twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
          }

          if (msg.type === 'response.created') sawAudioDelta = false;
          if (msg.type === 'response.done' && !sawAudioDelta) {
            console.log(`[${now()}] response.done but NO audio deltas this turn.`);
          }
        } catch (e) {
          console.error(`[${now()}] Realtime parse error:`, e);
        }
      });

      rt.on('error', (e) => {
        console.error(`[${now()}] Realtime WS error:`, e?.message || e);
      });

      rt.on('close', (code, reason) => {
        console.error(
          `[${now()}] Realtime closed. code=${code}, reason=${reason?.toString?.() || ''} retry=${retryCount}`
        );
        if (!closed && retryCount < 1) {
          retryCount += 1;
          setTimeout(() => {
            console.log(`[${now()}] Retrying Realtime connection...`);
            connectRealtime().then(() => resolve(true));
          }, 300);
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
      for (let i = 0; i < 50; i++) {
        twilioWS.send(JSON.stringify({ event: 'media', media: { payload: base64Silence() } }));
      }
    } catch {}
    try { twilioWS.close(); } catch {}
    return;
  }

  // Twilio -> Realtime
  twilioWS.on('message', (buf) => {
    try {
      const evt = JSON.parse(buf.toString());
      switch (evt.event) {
        case 'start':
          console.log(`[${now()}] Twilio start, from:`, evt?.start?.customParameters?.from);
          break;
        case 'media':
          if (evt.media?.payload) {
            sendRT({ type: 'input_audio_buffer.append', audio: evt.media.payload });
          }
          break;
        case 'stop':
          console.log(`[${now()}] Twilio stop`);
          sendRT({ type: 'input_audio_buffer.commit' });
          try { rt.close(); } catch {}
          try { twilioWS.close(); } catch {}
          break;
      }
    } catch (e) {
      console.error(`[${now()}] Twilio parse error:`, e);
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
