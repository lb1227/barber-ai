// server.js  — Twilio <Stream> ⇄ OpenAI Realtime (μ-law) voice bridge
// Requirements:
//   env: OPENAI_API_KEY (required)
//   env (optional): OPENAI_REALTIME_MODEL (default: gpt-4o-realtime-preview-2024-12-17)
// Run: node server.js

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in environment');
  process.exit(1);
}
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ----------------------------- health + info ----------------------------- */
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) =>
  res
    .status(200)
    .send(
      `Voice bridge alive. POST /voice from Twilio. Model=${REALTIME_MODEL}`
    )
);

/* ------------------------------ Twilio entry ----------------------------- */
app.post('/voice', (req, res) => {
  // Twilio will connect a bidirectional media WebSocket to /twilio
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const from = (req.body?.From || '').replace(/"/g, '');

  const twiml = `
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="from" value="${from}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  console.log('==> POST /voice -> will stream to', streamUrl);
  res.type('text/xml').send(twiml);
});

/* ------------------------- WebSocket upgrade path ------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/twilio')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/* -------------------- Twilio <-> OpenAI Realtime bridge ------------------ */
wss.on('connection', (twilioWS, req) => {
  const tag = Math.random().toString(36).slice(2, 6);
  let caller = '';
  console.log(`[${tag}] Twilio WS connected.`);

  // Connect to OpenAI Realtime WebSocket
  const rtUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;
  const openaiWS = new WebSocket(rtUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // Audio commit pacing: Twilio sends ~20ms per frame
  let msSinceCommit = 0;
  let appendedSinceCommit = false;
  const FRAME_MS = 20;
  const COMMIT_MS = 240; // commit roughly every ~240ms

  let rtReady = false;
  let closed = false;

  function safeClose() {
    if (closed) return;
    closed = true;
    try {
      twilioWS.close();
    } catch {}
    try {
      openaiWS.close();
    } catch {}
    console.log(`[${tag}] Bridge closed.`);
  }

  /* ----------------------- OpenAI -> Twilio handling ---------------------- */
  openaiWS.on('open', () => {
    console.log(`[${tag}] OpenAI WS open`);

    // Configure session to accept μ-law from Twilio and produce μ-law back
    const sessionUpdate = {
      type: 'session.update',
      session: {
        // IMPORTANT: These formats must match Twilio media (8kHz G.711 μ-law)
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // Make the assistant actually speak quickly and naturally
        instructions:
          'You are a friendly, concise phone receptionist. Respond promptly in a natural speaking style.',
      },
    };
    openaiWS.send(JSON.stringify(sessionUpdate));

    // Send a greeting immediately
    const greeting = {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        conversation: 'default',
        instructions:
          'Hello! Thanks for calling the barbershop — how can I help you today?',
      },
    };
    openaiWS.send(JSON.stringify(greeting));

    rtReady = true;
  });

  openaiWS.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Forward audio deltas to Twilio media stream
    if (msg.type === 'response.audio.delta' && msg.audio) {
      // Twilio expects base64 audio payload frames (μ-law)
      twilioWS.send(
        JSON.stringify({
          event: 'media',
          media: { payload: msg.audio },
        })
      );
    }

    // Helpful logging (optional)
    if (msg.type === 'error' || msg.type === 'response.error') {
      console.error(
        `[${tag}] OpenAI ERROR:`,
        JSON.stringify(msg, null, 2).slice(0, 1000)
      );
    }
    if (msg.type === 'response.created') {
      // ok
    }
    if (msg.type === 'response.completed') {
      // ok
    }
  });

  openaiWS.on('close', () => {
    console.log(`[${tag}] OpenAI WS closed`);
    safeClose();
  });
  openaiWS.on('error', (err) => {
    console.error(`[${tag}] OpenAI WS error:`, err?.message || err);
    safeClose();
  });

  /* ----------------------- Twilio -> OpenAI handling ---------------------- */
  twilioWS.on('message', (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const kind = evt?.event;

    if (kind === 'start') {
      caller = (evt?.start?.customParameters?.from || '').replace(/\D/g, '');
      console.log(`[${tag}] Twilio start, from: +${caller}`);
      return;
    }

    if (kind === 'media') {
      // Each Twilio frame is ~20ms of base64 G.711 μ-law
      if (!rtReady) return;

      const base64Ulaw = evt.media?.payload;
      if (!base64Ulaw) return;

      // Append this frame to OpenAI input buffer
      openaiWS.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Ulaw, // still μ-law; OpenAI session knows this format
        })
      );
      appendedSinceCommit = true;
      msSinceCommit += FRAME_MS;

      // Commit after enough audio has been appended to avoid "buffer too small"
      if (msSinceCommit >= COMMIT_MS) {
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        msSinceCommit = 0;
        appendedSinceCommit = false;
      }
      return;
    }

    if (kind === 'mark') {
      return; // ignore
    }

    if (kind === 'stop') {
      console.log(`[${tag}] Twilio stop`);
      // Final commit if we have uncommitted audio
      if (appendedSinceCommit) {
        try {
          openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        } catch {}
        appendedSinceCommit = false;
      }
      safeClose();
      return;
    }
  });

  twilioWS.on('close', () => {
    console.log(`[${tag}] Twilio WS closed`);
    safeClose();
  });
  twilioWS.on('error', (err) => {
    console.error(`[${tag}] Twilio WS error:`, err?.message || err);
    safeClose();
  });
});

/* --------------------------------- start --------------------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server listening on ${PORT}\n==> Your service is live ✅`)
);
