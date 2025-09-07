// server.js
// Minimal Twilio <-> OpenAI Realtime bridge that FORCES the bot to speak.
//
// Endpoints:
//   GET /            -> health check
//   GET /voice       -> TwiML that connects the call to wss://<host>/media
//   WS  /media       -> Twilio Media Stream <-> OpenAI Realtime bridge
//
// Audio: 8k G.711 μ-law end-to-end. No transcoding.
// Model: process.env.OPENAI_REALTIME_MODEL (required)

const http = require('http');
const url = require('url');
const crypto = require('crypto');
const WebSocket = require('ws');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_VOICE = process.env.POLLY_VOICE || 'alloy'; // any supported Realtime voice

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
}
if (!OPENAI_MODEL) {
  console.error('Missing OPENAI_REALTIME_MODEL');
}

const PORT = process.env.PORT || 10000;

/** Render a tiny TwiML that streams call audio to our /media WebSocket */
function twimlResponse(streamUrl) {
  // We use <Connect><Stream> to open a bi-directional media stream to our server.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hi! You are through to the Barber A I test. Now connecting.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
}

/** Create HTTP server to serve /voice and health endpoint */
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url, true);

  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return;
  }

  if (pathname === '/voice') {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const wsUrl = `wss://${host}/media`;

    const xml = twimlResponse(wsUrl);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(xml);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found\n');
});

/** WebSocket server for /media (Twilio Media Streams) */
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = url.parse(request.url);

  if (pathname === '/media') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

/** Helper: send JSON safely to a ws */
function sendJSON(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error('WS send error:', e.message);
  }
}

/** Main WS connection: one per ongoing call */
wss.on('connection', (twilioWS, req) => {
  const callTag = crypto.randomBytes(2).toString('hex');
  let streamSid = null;

  console.log(`==> [${callTag}] Twilio WS connected`);

  // ---- Open OpenAI Realtime WebSocket for this call
  const openAIUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const openAIHeaders = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
  const aiWS = new WebSocket(openAIUrl, { headers: openAIHeaders });

  // Track media frames for periodic commit (≥100ms per commit)
  let framesSinceCommit = 0;

  // Relay: Twilio -> OpenAI
  twilioWS.on('message', (msgBuf) => {
    let data;
    try {
      data = JSON.parse(msgBuf.toString());
    } catch (e) {
      return;
    }

    const { event } = data;

    if (event === 'start') {
      streamSid = data.start.streamSid;
      console.log(`[${callTag}] Twilio start ${streamSid}`);
      return;
    }

    if (event === 'media') {
      // Twilio sends 20ms μ-law (base64)
      const b64 = data.media.payload; // base64 G.711 μ-law
      // Append audio buffer into OpenAI
      sendJSON(aiWS, {
        type: 'input_audio_buffer.append',
        audio: b64
      });
      framesSinceCommit++;
      // Commit every 10 frames (~200ms), required by API
      if (framesSinceCommit >= 10) {
        sendJSON(aiWS, { type: 'input_audio_buffer.commit' });
        framesSinceCommit = 0;
      }
      return;
    }

    if (event === 'stop') {
      console.log(`[${callTag}] Twilio stop`);
      try { aiWS.close(); } catch {}
      try { twilioWS.close(); } catch {}
      return;
    }
  });

  twilioWS.on('close', () => {
    console.log(`[${callTag}] Twilio closed`);
    try { aiWS.close(); } catch {}
  });

  twilioWS.on('error', (err) => {
    console.error(`[${callTag}] Twilio WS error:`, err.message);
    try { aiWS.close(); } catch {}
  });

  // Relay: OpenAI -> Twilio
  aiWS.on('open', () => {
    console.log(`[${callTag}] [OpenAI] WS open`);

    // 1) Configure session: μ-law audio out, allow audio generation
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: OPENAI_VOICE,
        output_audio_format: 'g711_ulaw'
      }
    };
    sendJSON(aiWS, sessionUpdate);
    console.log(`[${callTag}] [OpenAI] -> session.update`, sessionUpdate.session);

    // 2) Force the first assistant turn to be AUDIO
    const responseCreate = {
      type: 'response.create',
      response: {
        modalities: ['audio'], // <— forces audio response
        instructions: 'Hello, you are connected to Barber A I.'
      }
    };
    sendJSON(aiWS, responseCreate);
    console.log(`[${callTag}] [OpenAI] -> response.create (audio)`);
  });

  aiWS.on('message', (msgBuf) => {
    let msg;
    try {
      msg = JSON.parse(msgBuf.toString());
    } catch {
      return;
    }

    // Uncomment to debug all events:
    // console.log(`[${callTag}] [OpenAI evt]`, msg.type);

    // Log text deltas if the model ever tries text only
    if (msg.type === 'response.output_text.delta' && msg.delta) {
      console.log(`[${callTag}] [OpenAI text]`, msg.delta);
    }

    // The audio we need to forward to the caller
    if (msg.type === 'response.output_audio.delta' && msg.delta) {
      const audioB64 = msg.delta; // already g711_ulaw base64
      if (twilioWS.readyState === WebSocket.OPEN && streamSid) {
        sendJSON(twilioWS, {
          event: 'media',
          streamSid,
          media: { payload: audioB64 }
        });
      }
      return;
    }

    if (msg.type === 'response.completed') {
      console.log(`[${callTag}] [OpenAI] response.completed`);
      return;
    }

    if (msg.type === 'error') {
      console.error(`[${callTag}] [OpenAI ERROR]`, msg);
      return;
    }
  });

  aiWS.on('close', () => {
    console.log(`[${callTag}] [OpenAI] WS closed`);
    try { twilioWS.close(); } catch {}
  });

  aiWS.on('error', (err) => {
    console.error(`[${callTag}] [OpenAI WS error]`, err.message);
    try { twilioWS.close(); } catch {}
  });
});

/** Start server */
server.listen(PORT, () => {
  console.log(`==> Minimal WS server ready at https://` +
              (process.env.RENDER_EXTERNAL_URL || `localhost:${PORT}`));
});
