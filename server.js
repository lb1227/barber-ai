// server.js — Twilio <-> OpenAI Realtime bridge (G.711 μ-law), with robust logging
// IMPORTANT: No `response.audio` in response.create. Voice/output format configured in session.update.

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*                          Twilio <Connect><Stream>                          */
/* -------------------------------------------------------------------------- */

app.post('/voice', (req, res) => {
  const wsUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl}" />
      </Connect>
    </Response>
  `.trim();

  console.log('==> /voice => will stream to', wsUrl);
  res.type('text/xml').send(twiml);
});

// Simple voice check (Twilio not required)
app.get('/voice-say', (_req, res) => {
  const say = `
    <Response>
      <Say>Hello! Your phone endpoint is reachable.</Say>
      <Pause length="1"/>
      <Say>Now call the main number to test realtime streaming.</Say>
    </Response>
  `.trim();
  res.type('text/xml').send(say);
});

app.get('/health', (_req, res) => res.send('ok'));

/* -------------------------------------------------------------------------- */
/*                            Upgrade -> /twilio WS                           */
/* -------------------------------------------------------------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/twilio')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/* -------------------------------------------------------------------------- */
/*                      Twilio WS <-> OpenAI Realtime WS                      */
/* -------------------------------------------------------------------------- */

wss.on('connection', async (twilioWS) => {
  const tag = Math.random().toString(36).slice(2, 6);
  const log = (...args) => console.log(`[${tag}]`, ...args);

  log('Twilio WS open');

  // Connect to OpenAI Realtime (server-side WS)
  const rtURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    REALTIME_MODEL
  )}`;

  const rt = new WebSocket(rtURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // Helper to send safely (buffer until open)
  const rtQueue = [];
  const sendRT = (obj) => {
    const msg = JSON.stringify(obj);
    if (rt.readyState === WebSocket.OPEN) {
      rt.send(msg);
    } else {
      rtQueue.push(msg);
    }
  };

  rt.on('open', () => {
    log('Realtime WS open');

    // Flush any queued messages
    if (rtQueue.length) {
      for (const m of rtQueue) rt.send(m);
      rtQueue.length = 0;
    }

    // Configure session: both input and output in μ-law, set voice.
    sendRT({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'verse',
      },
    });

    // Kick off with a greeting. NOTE: Do NOT include `response.audio` here.
    sendRT({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions:
          'Hello! Thanks for calling the barbershop. How can I help you today?',
      },
    });
  });

  rt.on('close', () => {
    log('Realtime closed');
    try {
      twilioWS.close();
    } catch {}
  });

  rt.on('error', (err) => {
    log('Realtime error:', err?.message || err);
    try {
      twilioWS.close();
    } catch {}
  });

  // Realtime events from OpenAI
  rt.on('message', (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch (e) {
      log('Realtime message parse error:', e);
      return;
    }

    // High-signal logs
    if (evt.type?.startsWith('response')) {
      if (evt.type === 'response.created') log('Realtime msg: response.created');
      if (evt.type === 'response.done') log('Realtime msg: response.done');
      if (evt.type === 'response.output_text.delta') {
        // text token (optional, not required for audio path)
      }
      // Some model variants use 'response.audio.delta', some use 'response.output_audio.delta'
      if (evt.type === 'response.audio.delta' && evt.audio) {
        // μ-law base64 payload from Realtime -> Twilio media
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: evt.audio },
          })
        );
      }
      if (evt.type === 'response.output_audio.delta' && evt.delta) {
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: evt.delta },
          })
        );
      }
      if (evt.type === 'response.completed') {
        log('Realtime msg: response.completed');
      }
    } else if (evt.type === 'session.updated') {
      log('Realtime msg: session.updated');
    } else if (evt.type === 'error') {
      log('Realtime ERROR payload:', JSON.stringify(evt, null, 2));
    }
  });

  // Twilio -> Realtime. We append audio and commit frequently so the model replies.
  let gotAudioSinceLastCommit = false;
  let commitTimer = null;
  const startCommitLoop = () => {
    if (commitTimer) return;
    commitTimer = setInterval(() => {
      if (!twilioWS || twilioWS.readyState !== WebSocket.OPEN) return;
      if (!rt || rt.readyState !== WebSocket.OPEN) return;

      if (gotAudioSinceLastCommit) {
        sendRT({ type: 'input_audio_buffer.commit' });
        gotAudioSinceLastCommit = false;
      }
    }, 350);
  };

  twilioWS.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start':
        log('Twilio start');
        startCommitLoop();
        break;

      case 'media': {
        const base64ULaw = msg.media?.payload;
        if (!base64ULaw) return;

        // Forward to Realtime input buffer
        sendRT({
          type: 'input_audio_buffer.append',
          audio: base64ULaw, // μ-law base64 from Twilio
        });
        gotAudioSinceLastCommit = true;
        break;
      }

      case 'mark':
        // Optional: could force a commit here too
        break;

      case 'stop':
        log('Twilio stop');
        try {
          sendRT({ type: 'input_audio_buffer.commit' });
        } catch {}
        try {
          rt.close();
        } catch {}
        try {
          twilioWS.close();
        } catch {}
        break;
    }
  });

  twilioWS.on('close', () => {
    log('Twilio WS closed');
    if (commitTimer) {
      clearInterval(commitTimer);
      commitTimer = null;
    }
    try {
      rt.close();
    } catch {}
  });

  twilioWS.on('error', (err) => {
    log('Twilio WS error:', err?.message || err);
    if (commitTimer) {
      clearInterval(commitTimer);
      commitTimer = null;
    }
    try {
      rt.close();
    } catch {}
  });
});

/* -------------------------------------------------------------------------- */

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
