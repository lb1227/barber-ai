// server.js — Twilio <-> OpenAI Realtime (μ-law, full-duplex) + /voice-say test
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { WebSocketServer } from 'ws';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

// ───────────────────────────────────────────────────────────────────────────────
// Health + simple Say route to test Twilio pointing
// ───────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice-say', (req, res) => {
  const twiml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">
        This is the simple test route. Your Twilio webhook is working.
      </Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// ───────────────────────────────────────────────────────────────────────────────
// Voice entry: Twilio -> connect stream to our WS endpoint
// ───────────────────────────────────────────────────────────────────────────────
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

const wss = new WebSocketServer({ noServer: true });
const server = app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Queue helper — don’t send to OpenAI until the WS is open
function makeQueuedSender(ws) {
  let open = false;
  const q = [];
  ws.on('open', () => {
    open = true;
    while (q.length) ws.send(q.shift());
  });
  return (payload) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (open) ws.send(data);
    else q.push(data);
  };
}

wss.on('connection', async (twilioWS, req) => {
  // Connect to OpenAI Realtime
  const rt = new (await import('ws')).WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  const sendRT = makeQueuedSender(rt);

  // ── OpenAI WS opened ────────────────────────────────────────────────────────
  rt.on('open', () => {
    console.log('Realtime WS open');

    // 1) Configure the session: μ-law in/out, voice at the session level
    sendRT({
      type: 'session.update',
      session: {
        // Twilio sends μ-law 8kHz
        input_audio_format: 'g711_ulaw',
        // Ask for μ-law out so we can pipe right back to Twilio
        output_audio_format: 'g711_ulaw',
        voice: 'alloy',
        instructions:
          'You are a friendly barber shop phone agent. Be concise and natural and reply in speech.',
      },
    });

    // 2) Proactive greeting (modalities must include BOTH audio and text)
    sendRT({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions:
          'Hello, thank you for calling XYZ barbershop. How can I help you today?',
      },
    });
  });

  rt.on('error', (e) => console.error('Realtime WS error:', e?.message || e));
  rt.on('close', () => {
    console.log('Realtime closed');
    try { twilioWS.close(); } catch {}
  });

  // ── Twilio -> OpenAI (caller audio) ─────────────────────────────────────────
  twilioWS.on('message', (buf) => {
    try {
      const event = JSON.parse(buf.toString());
      switch (event.event) {
        case 'start':
          console.log('Twilio start, from:', event?.start?.customParameters?.from);
          break;

        case 'media': {
          const ulaw = event.media?.payload; // base64 μ-law 8kHz
          if (ulaw) {
            sendRT({
              type: 'input_audio_buffer.append',
              audio: ulaw,
            });
          }
          break;
        }

        case 'stop':
          console.log('Twilio stop');
          sendRT({ type: 'input_audio_buffer.commit' });
          try { rt.close(); } catch {}
          try { twilioWS.close(); } catch {}
          break;
      }
    } catch (e) {
      console.error('Twilio message parse error:', e);
    }
  });

  twilioWS.on('close', () => {
    console.log('Twilio WS closed');
    try { rt.close(); } catch {}
  });

  twilioWS.on('error', (e) => {
    console.error('Twilio WS error:', e?.message || e);
    try { rt.close(); } catch {}
  });

  // ── OpenAI -> Twilio (assistant audio) ──────────────────────────────────────
  rt.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // (A) Log key events while debugging
      if (
        msg.type?.startsWith('response.') ||
        msg.type?.startsWith('input_audio_buffer.')
      ) {
        console.log('Realtime event:', msg.type);
      }

      // (B) When OpenAI detects the end of your speech, explicitly ask it to reply
      if (msg.type === 'input_audio_buffer.speech_stopped') {
        sendRT({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            // no instructions needed; it will continue the conversation
          },
        });
      }

      // (C) Pipe audio deltas back to Twilio. Some builds use response.output_audio.delta.
      if (
        (msg.type === 'response.audio.delta' && msg.audio) ||
        (msg.type === 'response.output_audio.delta' && msg.audio)
      ) {
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: msg.audio }, // base64 μ-law chunk
          })
        );
      }
    } catch (e) {
      console.error('Realtime message parse error:', e);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
