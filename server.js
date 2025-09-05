// server.js — Twilio <-> OpenAI Realtime (G.711 μ-law) with auto-reply + audio out
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
// Health + simple Say test
// ───────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice-say', (_req, res) => {
  const twiml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">This is the simple test route. Your Twilio webhook is working.</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// ───────────────────────────────────────────────────────────────────────────────
// Voice entry: connect Twilio to our WS bridge
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
const server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Queue helper so we don’t send to OpenAI before ws is OPEN
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

wss.on('connection', async (twilioWS) => {
  // Connect to OpenAI Realtime
  const rt = new (await import('ws')).WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );
  const sendRT = makeQueuedSender(rt);

  // Track whether we’ve seen audio deltas for diagnostics
  let sawAudioDelta = false;

  // ── OpenAI socket open: configure session + greet
  rt.on('open', () => {
    console.log('Realtime WS open');

    // Configure μ-law in/out; set a voice; add brief system style
    sendRT({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'alloy', // OpenAI voice used for streaming (fallback to a default if unknown)
        instructions:
          'You are a friendly barber shop phone agent. Be concise and natural and reply in speech.',
      },
    });

    // Proactive greeting — request audio specifically
    sendRT({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: 'Hello, thank you for calling XYZ barbershop. How can I help you today?',
        audio: { voice: 'alloy', format: 'g711_ulaw' },
      },
    });
  });

  rt.on('error', (e) => console.error('Realtime WS error:', e?.message || e));
  rt.on('close', () => {
    console.log('Realtime closed');
    try { twilioWS.close(); } catch {}
  });

  // ── Twilio -> OpenAI (caller audio)
  twilioWS.on('message', (buf) => {
    try {
      const evt = JSON.parse(buf.toString());
      switch (evt.event) {
        case 'start':
          console.log('Twilio start, from:', evt?.start?.customParameters?.from);
          break;
        case 'media': {
          const ulaw = evt.media?.payload; // base64 μ-law
          if (ulaw) {
            sendRT({ type: 'input_audio_buffer.append', audio: ulaw });
          }
          break;
        }
        case 'stop':
          console.log('Twilio stop');
          // Finalize anything remaining and close
          sendRT({ type: 'input_audio_buffer.commit' });
          try { rt.close(); } catch {}
          try { twilioWS.close(); } catch {}
          break;
      }
    } catch (e) {
      console.error('Twilio msg parse error:', e);
    }
  });

  twilioWS.on('close', () => { console.log('Twilio WS closed'); try { rt.close(); } catch {} });
  twilioWS.on('error', (e) => { console.error('Twilio WS error:', e?.message || e); try { rt.close(); } catch {} });

  // ── OpenAI -> Twilio (assistant audio + control events)
  rt.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Helpful diagnostics
      if (msg.type?.startsWith('response.') || msg.type?.startsWith('input_audio_buffer.')) {
        console.log('Realtime event:', msg.type);
      }

      // When model detects your speech ended, finalize and ask it to respond
      if (msg.type === 'input_audio_buffer.speech_stopped') {
        sendRT({ type: 'input_audio_buffer.commit' });
        sendRT({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            audio: { voice: 'alloy', format: 'g711_ulaw' },
          },
        });
      }

      // Stream audio back to Twilio — handle either delta name
      if (
        (msg.type === 'response.audio.delta' && msg.audio) ||
        (msg.type === 'response.output_audio.delta' && msg.audio)
      ) {
        sawAudioDelta = true;
        twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
      }

      // Optional: after a response finishes, log if we never saw audio deltas (debugging)
      if (msg.type === 'response.done' && !sawAudioDelta) {
        console.log('response.done but no audio deltas were received for this turn.');
      }
      if (msg.type === 'response.created') {
        sawAudioDelta = false; // reset per response
      }
    } catch (e) {
      console.error('Realtime msg parse error:', e);
    }
  });
});
