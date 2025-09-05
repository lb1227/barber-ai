// server.js — Twilio <-> OpenAI Realtime bridge (g711 μ-law) + simple Twilio test route
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ───────────────────────────────────────────────────────────────────────────────
//  HEALTH + simple Twilio “say” route (good sanity checks)
// ───────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice-say', (req, res) => {
  // A pure-Twilio Say to confirm your number is pointed at this app correctly.
  const twiml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">This is the test route speaking. Your Twilio webhooks are correct.</Say>
      <Pause length="1"/>
      <Say voice="Polly.Matthew-Neural">Now hanging up.</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// ───────────────────────────────────────────────────────────────────────────────
//  Production voice: Twilio Media Streams -> OpenAI Realtime (g711 μ-law)
// ───────────────────────────────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  // Twilio Connect Stream to our WS endpoint
  const url = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${url}">
          <Parameter name="from" value="${(req.body?.From || '').replace(/"/g, '')}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// WS server for Twilio Stream
const wss = new WebSocketServer({ noServer: true });

// HTTP -> WS upgrade
const server = app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Utility: queue sends until ws is actually open
function makeQueuedSender(ws) {
  let open = false;
  const queue = [];
  ws.on('open', () => {
    open = true;
    while (queue.length) ws.send(queue.shift());
  });
  return (payload) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (open) ws.send(data);
    else queue.push(data);
  };
}

wss.on('connection', async (twilioWS, req) => {
  // OpenAI Realtime WS
  const rt = new (await import('ws')).WebSocket(
    'wss://api.openai.com/v1/realtime?model=' +
      encodeURIComponent(process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17'),
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  const sendRT = makeQueuedSender(rt);

  // When RT opens, configure session and greet
  rt.on('open', () => {
    console.log('Realtime WS open');

    // (1) Tell OpenAI the incoming audio is μ-law and request μ-law out.
    sendRT({
      type: 'session.update',
      session: {
        // MUST be a string (earlier error was sending an object)
        input_audio_format: 'g711_ulaw',
        // Ask the model to produce μ-law back
        output_audio_format: 'g711_ulaw',
        // A short instruction is optional, but helpful
        instructions:
          'You are a friendly barber shop phone agent. Be concise and natural. Listen and reply in speech.',
      },
    });

    // (2) Proactively greet the caller. Note: modalities must be ['audio','text']
    sendRT({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: 'Hello, thank you for calling XYZ barbershop. How can I help you today?',
        audio: {
          // voice name is ignored for μ-law, but must be present
          voice: 'alloy',
          format: 'g711_ulaw',
        },
      },
    });
  });

  rt.on('error', (e) => console.error('Realtime WS error:', e.message || e));
  rt.on('close', () => {
    console.log('Realtime closed');
    try { twilioWS.close(); } catch {}
  });

  // Twilio -> OpenAI (caller audio)
  twilioWS.on('message', (msg) => {
    try {
      const event = JSON.parse(msg.toString());
      switch (event.event) {
        case 'start':
          console.log('Twilio start, from:', event?.start?.customParameters?.from);
          break;

        case 'media': {
          // Twilio sends base64 μ-law frames
          const ulaw = event.media?.payload;
          if (ulaw) {
            sendRT({
              type: 'input_audio_buffer.append',
              audio: ulaw, // base64 μ-law
            });
          }
          break;
        }

        case 'mark':
          // ignore
          break;

        case 'stop':
          console.log('Twilio stop');
          // finalize any buffered audio on the OpenAI side
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
    console.error('Twilio WS error:', e.message || e);
    try { rt.close(); } catch {}
  });

  // OpenAI -> Twilio (assistant audio)
  rt.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Most useful to log high-level events while debugging:
      if (msg.type?.startsWith('response.') || msg.type?.startsWith('input_audio_buffer.')) {
        console.log('Realtime event:', msg.type);
      }

      // The audio deltas come as base64 payload (μ-law) in response.audio.delta
      if (msg.type === 'response.audio.delta' && msg.audio) {
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: msg.audio }, // Twilio expects base64 μ-law
          })
        );
      }

      // Once a response is done, you can create another response if you want the
      // assistant to take the next turn automatically. For now we let the user speak.
      // if (msg.type === 'response.done') { ... }

    } catch (e) {
      console.error('Realtime message parse error:', e);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Done
// ───────────────────────────────────────────────────────────────────────────────
