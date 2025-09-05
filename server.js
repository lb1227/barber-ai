// server.js (ESM)
// Minimal, stable Twilio <-> OpenAI Realtime bridge (u-law pass-through, hello greeting)

// ===== Imports (ESM) =====
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

// ===== Environment =====
const PORT = process.env.PORT || 10000;
const HOST = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment.');
  process.exit(1);
}

// ===== Express HTTP app =====
const app = express();
app.use(express.json());

// Health + simple speaker test (Render health checks)
app.get('/health', (req, res) => res.status(200).send('ok'));

// TwiML to point the call’s media stream to our WS endpoint
app.post('/voice', (req, res) => {
  // figure out our own wss URL
  const base =
    HOST ||
    (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
      ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
      : `https://${req.headers.host}`);

  // The WebSocket Twilio should connect to:
  const streamUrl = `${base.replace(/^http/, 'ws')}/twilio`;

  // Minimal TwiML
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}"/>
      </Connect>
    </Response>
  `.trim();

  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// Friendly landing
app.get('/', (req, res) => {
  const base =
    HOST ||
    (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
      ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
      : `https://${req.headers.host}`);
  res.type('text/plain').send(
    [
      'Your service is live 🎉',
      '',
      `Available at your primary URL ${base}`,
      '',
      'POST /voice -> will stream to wss://.../twilio',
    ].join('\n')
  );
});

// ===== HTTP + WS server =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Helpers ----------
function safeSend(ws, obj) {
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (_) {}
}

function log(prefix, msg) {
  console.log(`${new Date().toISOString()} ${prefix} ${msg}`);
}

// Converts Twilio base64 payload (u-law) into the frame we’ll append to OpenAI
function makeAppendEvent_ulaw(base64) {
  // For the realtime API, we append audio like:
  // {type: "input_audio_buffer.append", audio: {data: "<base64>", format: "g711_ulaw"}}
  return {
    type: 'input_audio_buffer.append',
    audio: { data: base64, format: 'g711_ulaw' },
  };
}

// ---------- Core bridge per Twilio call ----------
wss.on('connection', async (twilioWS, req) => {
  const connId = crypto.randomBytes(4).toString('hex');

  log(connId, 'Twilio WS connected.');

  // Create OpenAI realtime WS
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  let streamSid = null;

  // Collect u-law frames from Twilio (each ~20ms) and push to OpenAI in >=100ms batches
  let appendBuffer = [];
  let framesSinceCommit = 0;

  // Utility: commit buffered audio to OpenAI
  function commitIfReady(force = false) {
    const FRAMES_NEEDED = 5; // 5 * 20ms = 100ms
    if (!force && framesSinceCommit < FRAMES_NEEDED) return;

    if (appendBuffer.length > 0) {
      // send all pending append first
      for (const ev of appendBuffer) safeSend(openaiWS, ev);
      appendBuffer = [];
    }

    // then commit
    safeSend(openaiWS, { type: 'input_audio_buffer.commit' });
    framesSinceCommit = 0;
  }

  // ---- OpenAI WS events ----
  openaiWS.on('open', () => {
    log(connId, 'OpenAI WS open');

    // 1) Tell OpenAI we’ll stream G.711 µ-law in from Twilio
    safeSend(openaiWS, {
      type: 'session.update',
      session: {
        // VERY IMPORTANT: input format matches what Twilio sends us:
        input_audio_format: 'g711_ulaw',
      },
    });

    // 2) Say hello once so you can verify audio is flowing back out.
    //    We ask for ['audio','text'] to satisfy the API’s valid combinations.
    safeSend(openaiWS, {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: 'Say "Hello".',
        audio: {
          voice: 'alloy', // use a supported voice (e.g., alloy, coral, ash, etc.)
          format: 'g711_ulaw', // produce µ-law so we can pass directly to Twilio
        },
      },
    });
  });

  openaiWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Forward audio deltas to the caller via Twilio
      if (
        msg.type === 'response.output_audio.delta' &&
        msg.delta &&
        streamSid
      ) {
        // Twilio expects:
        // {event: "media", streamSid, media: {payload: "<base64 g711_ulaw>"}}
        safeSend(twilioWS, {
          event: 'media',
          streamSid,
          media: { payload: msg.delta },
        });
      }

      // When a response finishes, send a mark so Twilio can segment if needed
      if (msg.type === 'response.completed' && streamSid) {
        safeSend(twilioWS, {
          event: 'mark',
          streamSid,
          mark: { name: 'openai_response_complete' },
        });
      }
    } catch (e) {
      // non-JSON or unimportant event
    }
  });

  openaiWS.on('close', () => {
    log(connId, 'OpenAI WS closed');
    try {
      twilioWS.close();
    } catch (_) {}
  });

  openaiWS.on('error', (err) => {
    log(connId, `OpenAI WS ERROR: ${err?.message || err}`);
  });

  // ---- Twilio WS events ----
  twilioWS.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    switch (m.event) {
      case 'start':
        streamSid = m.start?.streamSid;
        log(connId, `Twilio start, streamSid: ${streamSid}`);
        break;

      case 'media': {
        // Each Twilio frame is ~20ms of G.711 µ-law at 8kHz, base64-encoded in m.media.payload
        const b64 = m.media?.payload;
        if (b64 && openaiWS.readyState === WebSocket.OPEN) {
          appendBuffer.push(makeAppendEvent_ulaw(b64));
          framesSinceCommit += 1;
          commitIfReady(false); // will auto-commit every ~100ms
        }
        break;
      }

      case 'mark':
      case 'stop':
        // Final flush in case a few frames remain
        commitIfReady(true);
        log(connId, `Twilio ${m.event}`);
        break;

      default:
        break;
    }
  });

  twilioWS.on('close', () => {
    log(connId, 'Twilio WS closed');
    try {
      // final flush
      commitIfReady(true);
      openaiWS.close();
    } catch (_) {}
  });

  twilioWS.on('error', (err) => {
    log(connId, `Twilio WS ERROR: ${err?.message || err}`);
  });

  // Housekeeping: keep both sockets alive
  const pingInt = setInterval(() => {
    try {
      if (twilioWS.readyState === WebSocket.OPEN) twilioWS.ping();
      if (openaiWS.readyState === WebSocket.OPEN) openaiWS.ping();
    } catch (_) {}
  }, 25000);

  twilioWS.on('close', () => clearInterval(pingInt));
  openaiWS.on('close', () => clearInterval(pingInt));
});

// ===== Start =====
server.listen(PORT, () => {
  const url =
    HOST ||
    (process.env.RENDER ? `https://${process.env.RENDER_EXTERNAL_URL}` : '');
  console.log('////////////////////////////////////////////////////////');
  console.log(`Server listening on ${PORT}`);
  console.log('Your service is live 🎉');
  if (url) {
    console.log('////////////////////////////////////////////////////////');
    console.log(`Available at your primary URL ${url}`);
  }
  console.log('////////////////////////////////////////////////////////');
});
