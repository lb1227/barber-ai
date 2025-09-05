// server.js — Twilio <-> OpenAI Realtime (μ-law) with proper buffering
import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Config ----
const PORT = process.env.PORT || 10000;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const INSTRUCTIONS = `
You are the friendly receptionist for XYZ Barbershop.
Answer briefly and naturally. You can speak as soon as the caller says something.
`;

// ---- Twilio entry point (TwiML) ----
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${(req.body.From || '').replace(/"/g,'')}"/>
        </Stream>
      </Connect>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

// Simple health & test routes
app.get('/health', (_req, res) => res.send('ok'));
app.get('/voice-say', (_req, res) => {
  const xml = `
    <Response>
      <Say voice="Polly.Matthew-Neural">This is your Twilio test. The web service is reachable.</Say>
    </Response>
  `;
  res.type('text/xml').send(xml.trim());
});

// ---- WebSocket upgrade for Twilio media stream ----
const server = app.listen(PORT, () => {
  console.log('Server listening on', PORT);
  console.log('=> Your service is live 🌐');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---- Core bridge: Twilio <-> OpenAI Realtime ----
wss.on('connection', async (twilioWS, req) => {
  console.log('Twilio WS open');

  // Connect to OpenAI Realtime WS (μ-law, 8kHz)
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const openaiWS = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    }
  });

  // Buffer 5 Twilio frames (~20ms each) before committing (>=100ms)
  let frameQueue = [];
  const FRAMES_PER_COMMIT = 5;

  const flushInputBuffer = () => {
    if (frameQueue.length === 0) return;
    // append all frames since last commit
    for (const payload of frameQueue) {
      openaiWS.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: payload   // base64 g711 μ-law
      }));
    }
    frameQueue = [];
    // then commit
    openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  };

  // Forward model audio deltas to Twilio
  const handleOpenAIMessage = (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'response.audio.delta' && msg.audio) {
        // Send PCM μ-law base64 back to Twilio
        twilioWS.send(JSON.stringify({
          event: 'media',
          media: { payload: msg.audio }
        }));
      }

      if (msg.type === 'response.completed') {
        // model finished speaking — nothing special required
      }

      if (msg.type === 'error') {
        console.error('Realtime ERROR payload:', JSON.stringify(msg, null, 2));
      }

      // Useful debug traces:
      if (msg.type === 'session.updated' || msg.type === 'session.created') {
        console.log('Realtime event:', msg.type);
      }
      if (msg.type === 'response.created' || msg.type === 'response.done') {
        console.log('Realtime event:', msg.type);
      }

    } catch (e) {
      // ignore parse errors
    }
  };

  openaiWS.on('open', () => {
    console.log('OpenAI WS open');

    // Configure session: input μ-law, and we’ll ask for μ-law audio out
    openaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        // Twilio sends μ-law 8kHz:
        input_audio_format: 'g711_ulaw',
        // Hints/voice for TTS
        instructions: INSTRUCTIONS,
      }
    }));

    // Initial greeting (modalities must be ['audio','text'])
    openaiWS.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        audio_format: 'g711_ulaw',
        instructions: 'Hello, thanks for calling XYZ Barbershop. How can I help you today?'
      }
    }));
  });

  openaiWS.on('message', handleOpenAIMessage);

  openaiWS.on('close', () => {
    try { twilioWS.close(); } catch {}
    console.log('OpenAI WS closed');
  });

  openaiWS.on('error', (err) => {
    console.error('OpenAI WS error:', err?.message || err);
    try { twilioWS.close(); } catch {}
  });

  // ---- Twilio events -> OpenAI ----
  twilioWS.on('message', (data) => {
    try {
      const evt = JSON.parse(data.toString());

      switch (evt.event) {
        case 'start':
          console.log('Twilio start, from:', evt?.start?.customParameters?.from || '');
          break;

        case 'media': {
          // Queue each 20ms μ-law frame; commit every >=100ms (5 frames)
          const payload = evt.media?.payload;
          if (payload) {
            frameQueue.push(payload);
            if (frameQueue.length >= FRAMES_PER_COMMIT) {
              flushInputBuffer();
            }
          }
          break;
        }

        case 'stop':
          // Final flush on hangup
          flushInputBuffer();
          try { openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch {}
          try { openaiWS.close(); } catch {}
          try { twilioWS.close(); } catch {}
          console.log('Twilio stop');
          break;

        default:
          break;
      }
    } catch { /* ignore */ }
  });

  twilioWS.on('close', () => {
    try { openaiWS.close(); } catch {}
    console.log('Twilio WS closed');
  });

  twilioWS.on('error', () => {
    try { openaiWS.close(); } catch {}
  });
});
