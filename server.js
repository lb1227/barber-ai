// server.js — Minimal Twilio <-> OpenAI Realtime bridge that SPEAKS "hello"
// ESM module (type: module in package.json)
import 'dotenv/config';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ----------------- Config you may change later -----------------
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const VOICE = process.env.POLLY_VOICE || 'Matthew'; // OpenAI voice hint; name is ignored for μ-law output but fine.
const HELLO = 'Hello, thanks for calling.';
// ----------------------------------------------------------------

if (!OPENAI_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// ----- simple console logger -----
function log(tag, msg, obj) {
  const ts = new Date().toISOString().slice(11, 19);
  if (obj) console.log(ts, tag, msg, obj);
  else console.log(ts, tag, msg);
}

// TwiML entrypoint: connect Twilio Media Streams to our WS
app.post('/voice', (req, res) => {
  const streamUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}"/>
      </Connect>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// Health + quick sanity check
app.get('/health', (_req, res) => res.send('ok'));

// (Optional) test path that just speaks a canned message with <Say> (no Realtime)
app.post('/voice-say', (req, res) => {
  const twiml = `
    <Response>
      <Say>Hello from a basic test route. If you can hear this, Twilio is good.</Say>
      <Hangup/>
    </Response>
  `.trim();
  res.type('text/xml').send(twiml);
});

// ===================== WebSocket Bridge =====================
let wss;
function ensureWSS(server) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/twilio')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (twilioWS) => {
    log('INFO', 'Twilio WS connected.');

    // ----------------- OpenAI Realtime client -----------------
    const rtURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
    const openaiWS = new WebSocket(rtURL, {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    // Keep a small buffer of caller frames (Twilio sends 20ms μ-law frames).
    // The API requires >= 100ms per commit, so we commit every 5 frames.
    let frameAccumulator = [];
    const FRAMES_PER_COMMIT = 5; // 5 * 20ms = 100ms

    function commitIfReady() {
      if (frameAccumulator.length >= FRAMES_PER_COMMIT) {
        // Concatenate base64 strings; the API accepts a single base64 string.
        const audioB64 = frameAccumulator.join('');
        frameAccumulator = [];
        try {
          openaiWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: audioB64 // μ-law base64
          }));
          openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          // Ask the model to respond to recent input (auto-conversation flow)
          openaiWS.send(JSON.stringify({
            type: 'response.create',
            response: { conversation: 'auto' }
          }));
        } catch (e) {
          log('ERR', 'Commit/send failed', e.message);
        }
      }
    }

    // ---- OpenAI events ----
    openaiWS.on('open', () => {
      log('INFO', 'OpenAI WS open.');

      // Configure the session: both input AND output are μ-law (Twilio friendly).
      // Using correct field names & values to avoid the "unknown / invalid" errors.
      openaiWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          // IMPORTANT: these must be STRINGS, not objects
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          // Voice is a hint; output_audio_format controls the codec we actually get back
          voice: VOICE
        }
      }));

      // Send an immediate spoken greeting so you hear speech even if you say nothing.
      openaiWS.send(JSON.stringify({
        type: 'response.create',
        response: {
          instructions: HELLO,
          // The API requires ['audio','text'] or ['text']; use the safe combo:
          modalities: ['audio', 'text'],
          // 'default' is invalid — use 'auto' or 'none'
          conversation: 'auto'
        }
      }));
    });

    openaiWS.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Forward audio deltas to Twilio. The correct event is response.output_audio.delta
        if (msg.type === 'response.output_audio.delta' && msg.audio) {
          // Twilio expects JSON frames: {event:'media', media:{payload:<base64 μ-law>}}
          twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
        }

        if (msg.type === 'response.completed' || msg.type === 'response.done') {
          // no-op; just logging
          log('INFO', 'OpenAI response done.');
        }

        if (msg.type === 'error') {
          log('OpenAI ERROR', '', msg);
        }
      } catch (e) {
        log('ERR', 'Parse OpenAI message failed', e.message);
      }
    });

    openaiWS.on('close', () => {
      log('INFO', 'OpenAI WS closed.');
      try { twilioWS.close(); } catch {}
    });
    openaiWS.on('error', (e) => log('ERR', 'OpenAI WS error', e.message));

    // ---- Twilio events ----
    twilioWS.on('message', (raw) => {
      try {
        const evt = JSON.parse(raw.toString());

        if (evt.event === 'start') {
          log('INFO', `Twilio start, streamSid: ${evt?.start?.streamSid || '(unknown)'}`);
        }

        if (evt.event === 'media') {
          // This is a 20ms μ-law base64 chunk from Twilio
          frameAccumulator.push(evt.media.payload || '');
          // Commit whenever we have ≥100ms buffered
          commitIfReady();
        }

        if (evt.event === 'stop') {
          // Final flush if we buffered <100ms (optional; will be ignored if too small)
          commitIfReady();
          try { openaiWS.close(); } catch {}
          try { twilioWS.close(); } catch {}
          log('INFO', 'Twilio stop.');
        }
      } catch (e) {
        log('ERR', 'Parse Twilio message failed', e.message);
      }
    });

    twilioWS.on('close', () => {
      log('INFO', 'Twilio WS closed.');
      try { openaiWS.close(); } catch {}
    });
    twilioWS.on('error', (e) => log('ERR', 'Twilio WS error', e.message));
  });

  return wss;
}

// Start server + WS
const server = app.listen(PORT, () => {
  console.log(`\n==> Server listening on ${PORT}`);
  console.log('==> Your service is live 🌐');
  console.log(`==> Available at your primary URL https://barber-ai.onrender.com`);
  console.log('==> //////////////////////////////////////////////////////////////\n');
});

ensureWSS(server);
