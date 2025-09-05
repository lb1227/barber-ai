// server.js — Minimal "Hello" phone bot using Twilio Media Streams + OpenAI Realtime
import 'dotenv/config';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* -------------------- Twilio entry (TwiML) -------------------- */
app.post('/voice', (req, res) => {
  // Twilio will connect a bidirectional media stream to our /twilio WebSocket.
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}" />
      </Connect>
    </Response>
  `.trim();
  console.log('==> POST /voice -> will stream to', streamUrl);
  res.type('text/xml').send(twiml);
});

/* -------------------- Health -------------------- */
app.get('/health', (_req, res) => res.send('ok'));

/* -------------------- WebSocket bridge -------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/twilio')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/* Utility: safe JSON parse */
const tryParse = (buf) => {
  try { return JSON.parse(buf.toString()); } catch { return null; }
};

/* -------------------- Connection handler -------------------- */
wss.on('connection', async (twilioWS) => {
  const tag = crypto.randomBytes(3).toString('hex');
  const log = (...a) => console.log(`[${tag}]`, ...a);

  log('Twilio WS connected.');

  // 1) Open OpenAI Realtime WS
  const oaURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const oaWS = new WebSocket(oaURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // ---- Outgoing audio back to Twilio ----
  // OpenAI will push audio deltas in g711 μ-law because we ask for it.
  oaWS.on('message', (data) => {
    const msg = tryParse(data);
    if (!msg) return;

    // Newer API emits "response.audio.delta"; older builds use "output_audio.delta".
    const isAudioDelta =
      (msg.type === 'response.audio.delta' && msg.audio) ||
      (msg.type === 'output_audio.delta'  && msg.delta);

    if (isAudioDelta) {
      const b64 = msg.audio || msg.delta; // normalize
      // Forward to Twilio as a media frame
      twilioWS.send(JSON.stringify({ event: 'media', media: { payload: b64 } }));
    }

    if (msg.type === 'response.completed' || msg.type === 'response.done') {
      log('OpenAI finished one response.');
    }

    if (msg.type === 'error') {
      log('OpenAI ERROR:', JSON.stringify(msg, null, 2));
    }
  });

  oaWS.on('open', () => {
    log('OpenAI WS open');

    // 2) Configure session: input/output formats and voice
    // Twilio sends 8kHz μ-law; tell OpenAI to expect/emit the same.
    oaWS.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          // Accept 8kHz μ-law from Twilio
          input_audio_format: { type: 'g711_ulaw' },
          // Return 8kHz μ-law to Twilio
          output_audio_format: { type: 'g711_ulaw' },
          // TTS voice
          voice: 'verse',
        },
      })
    );

    // 3) Say hello once the session is ready
    oaWS.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          // Must include BOTH ['audio','text'] to satisfy the API (your logs showed this).
          modalities: ['audio', 'text'],
          instructions: 'Hello! How can I help you?',
        },
      })
    );
  });

  oaWS.on('close', () => {
    log('OpenAI WS closed');
    try { twilioWS.close(); } catch {}
  });

  oaWS.on('error', (err) => {
    log('OpenAI WS error:', err?.message || err);
    try { twilioWS.close(); } catch {}
  });

  /* --------------- Incoming audio from Twilio -> OpenAI --------------- */
  // We append frames and only COMMIT when we have enough audio collected to avoid
  // "input_audio_buffer_commit_empty" errors.
  let haveUncommitted = false;
  let lastCommitTs = 0;

  // Commit at most every 500ms if we appended anything.
  const COMMIT_INTERVAL_MS = 500;

  const maybeCommit = () => {
    const now = Date.now();
    if (!haveUncommitted) return;
    if (now - lastCommitTs < COMMIT_INTERVAL_MS) return;
    haveUncommitted = false;
    lastCommitTs = now;
    if (oaWS.readyState === WebSocket.OPEN) {
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }
  };

  const commitTimer = setInterval(maybeCommit, 100);

  twilioWS.on('message', (buf) => {
    const evt = tryParse(buf);
    if (!evt || !evt.event) return;

    if (evt.event === 'start') {
      log('Twilio start, stream:', evt?.start?.streamSid, 'from:', evt?.start?.from);
      return;
    }

    if (evt.event === 'media') {
      const b64 = evt.media?.payload;
      if (b64 && oaWS.readyState === WebSocket.OPEN) {
        // Twilio payload is g711 μ-law base64 — append directly.
        oaWS.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: b64,
          })
        );
        haveUncommitted = true;
      }
      return;
    }

    if (evt.event === 'stop') {
      log('Twilio stop');
      // Final commit & request a response (short confirmation)
      if (oaWS.readyState === WebSocket.OPEN) {
        if (haveUncommitted) {
          oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          haveUncommitted = false;
        }
        oaWS.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              instructions: 'Goodbye!',
            },
          })
        );
      }
      try { clearInterval(commitTimer); } catch {}
      try { oaWS.close(); } catch {}
      try { twilioWS.close(); } catch {}
      return;
    }
  });

  twilioWS.on('close', () => {
    log('Twilio WS closed');
    try { clearInterval(commitTimer); } catch {}
    try { oaWS.close(); } catch {}
  });

  twilioWS.on('error', (err) => {
    log('Twilio WS error:', err?.message || err);
    try { clearInterval(commitTimer); } catch {}
    try { oaWS.close(); } catch {}
  });
});

/* -------------------- Start server -------------------- */
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log('==> Available at your primary URL');
});
