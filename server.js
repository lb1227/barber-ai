// server.js — Twilio <-> OpenAI Realtime (g711_ulaw), with 100ms commits
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---------- config ---------- */
const PORT = process.env.PORT || 3000;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BUSINESS_NAME = 'XYZ barbershop';
const TZ = 'America/New_York'; // just used in instructions

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

/* ---------- health ---------- */
app.get('/health', (_req, res) => res.type('text').send('ok'));

/* ---------- quick voice sanity check (Polly/Twilio TTS) ---------- */
app.post('/voice-say', (_req, res) => {
  // This uses Twilio TTS (Polly voice configured in your Twilio account)
  const twiml = `
    <Response>
      <Say>Hello from ${BUSINESS_NAME}. This is a simple voice test. If you hear this, your Twilio number is working.</Say>
      <Hangup/>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

/* ---------- Twilio entry: start the bidirectional stream ---------- */
app.post('/voice', (req, res) => {
  // Twilio will open a <Stream/> to our WS at /twilio
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${(req.body.From || '').replace(/"/g, '')}"/>
        </Stream>
      </Connect>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

/* ---------- WS Bridge: Twilio <-> OpenAI Realtime ---------- */
const wss = new WebSocketServer({ noServer: true });

function log(prefix, msg) {
  console.log(prefix, msg);
}

function twilioBase64PayloadToLengthSeconds(b64) {
  // Twilio sends G.711 μ-law (1 byte per sample @ 8000 Hz). Length = bytes.
  const bytes = Buffer.from(b64, 'base64').length;
  const seconds = bytes / 8000.0;
  return seconds;
}

function createOpenAIRealtimeSocket() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });
  return ws;
}

/* Handle HTTP upgrade for /twilio only */
const server = app.listen(PORT, () =>
  console.log('Server listening on', PORT)
);

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (twilioWS, req) => {
  const tag = Math.random().toString(36).slice(2, 6);
  log(tag, 'Twilio WS connected.');

  // 1) Connect to OpenAI Realtime
  const openaiWS = createOpenAIRealtimeSocket();

  // We will batch 100ms of audio before commit
  let pendingFrames = [];
  let pendingSeconds = 0.0;
  const COMMIT_INTERVAL_SEC = 0.10; // 100 ms

  let openaiReady = false;

  /* ---------- OPENAI WS Handlers ---------- */
  openaiWS.onopen = () => {
    openaiReady = true;
    log(tag, 'OpenAI WS open');

    // Tell the session we speak G711 μ-law both directions and set instructions
    const sessionUpdate = {
      type: 'session.update',
      session: {
        // must be a string per API (logs showed we sent an object before)
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // voice hint; model may pick a default
        voice: 'verse',
        instructions: `
You are a friendly, concise phone receptionist for ${BUSINESS_NAME}.
- Greet the caller right away.
- Help book / reschedule / cancel appointments. Ask only for missing info.
- Keep responses short, natural, and confirm details.
Assume timezone ${TZ}.
        `.trim(),
      },
    };
    openaiWS.send(JSON.stringify(sessionUpdate));

    // Immediately speak a greeting (modalities must be ['audio','text'])
    const greet = {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: `Hello, thanks for calling ${BUSINESS_NAME}. How can I help you today?`,
      },
    };
    openaiWS.send(JSON.stringify(greet));
  };

  openaiWS.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data.toString());

      // Audio back from OpenAI: correct channel is response.output_audio.delta
      if (data.type === 'response.output_audio.delta' && data.audio) {
        // Pipe to Twilio as a media frame (base64 G.711 μ-law)
        twilioWS.send(
          JSON.stringify({ event: 'media', media: { payload: data.audio } })
        );
      }

      // Debug state transitions
      if (data.type === 'response.created') log(tag, 'response.created');
      if (data.type === 'response.completed') log(tag, 'response.completed');
      if (data.type === 'response.output_text.done')
        log(tag, 'text done:', data);
      if (data.type === 'error') {
        log(
          tag,
          'OpenAI ERROR:',
          JSON.stringify(data, null, 2)
        );
      }
    } catch (e) {
      // occasionally OpenAI sends pings or non-JSON frames later; ignore
    }
  };

  openaiWS.onerror = (e) => {
    log(tag, 'OpenAI WS error', e.message || e);
  };

  openaiWS.onclose = () => {
    log(tag, 'OpenAI WS closed');
    try {
      twilioWS.close();
    } catch {}
  };

  /* ---------- TWILIO WS Handlers ---------- */
  twilioWS.on('message', (raw) => {
    if (!openaiReady) return; // wait until session is configured

    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === 'start') {
      log(tag, `Twilio start, stream: ${msg.start.streamSid} from: ${msg.start.customParameters?.from || '(unknown)'}`);
      return;
    }

    if (msg.event === 'media') {
      // Twilio media payload (base64 g711 μ-law 8kHz)
      const payload = msg.media.payload;

      // Send to OpenAI audio buffer
      openaiWS.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: payload, // must be base64 g711_ulaw
        })
      );

      // batch length computed from bytes/8000
      pendingFrames.push(payload);
      pendingSeconds += twilioBase64PayloadToLengthSeconds(payload);

      // Only commit after >=100ms of buffered audio
      if (pendingSeconds >= COMMIT_INTERVAL_SEC) {
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        // Optionally request a response turn after we’ve got some audio
        openaiWS.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              instructions: '', // letting the model infer from audio
            },
          })
        );
        pendingFrames = [];
        pendingSeconds = 0.0;
      }
      return;
    }

    if (msg.event === 'mark') return;

    if (msg.event === 'stop') {
      log(tag, 'Twilio stop');
      try {
        // Final commit in case frames remain
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      } catch {}
      try {
        openaiWS.close();
      } catch {}
      try {
        twilioWS.close();
      } catch {}
      return;
    }
  });

  twilioWS.on('close', () => {
    log(tag, 'Twilio WS closed');
    try {
      openaiWS.close();
    } catch {}
  });

  twilioWS.on('error', (e) => {
    log(tag, 'Twilio WS error', e.message || e);
    try {
      openaiWS.close();
    } catch {}
  });
});
