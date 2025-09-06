// src/server.js  — CommonJS server, minimal Twilio <-> OpenAI bridge (inbound audio only)
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // must be set in Render
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- health check ---
app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// --- optional Twilio status callback (you added this in TwiML) ---
app.post('/twilio-status', (req, res) => {
  console.log('Twilio status callback:', JSON.stringify(req.body || {}, null, 2));
  res.sendStatus(200);
});

// --- Twilio <Stream> WS endpoint ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Utility: sign OpenAI Realtime auth header
function openAIAuthHeader() {
  return {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
}

// When Twilio upgrades to /twilio, we accept the WS and bridge it
server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  if (!url || !url.startsWith('/twilio')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    handleTwilioStream(ws);
  });
});

function handleTwilioStream(twilioWS) {
  console.log('✅ WS CONNECTED on /twilio from', twilioWS._socket?.remoteAddress || 'unknown');

  // Twilio will send media with 8kHz μ-law (g711ulaw) when you use track="inbound_track".
  // We forward that audio to OpenAI Realtime as-is (no transcoding), and relay any audio deltas back.

  // Connect to OpenAI Realtime
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}&voice=alloy`;
  const openaiWS = new WebSocket(url, { headers: openAIAuthHeader() });

  openaiWS.on('open', () => {
    console.log('🔗 OpenAI WS open');
    // Tell OpenAI our session uses g711-ulaw 8k mono
    openaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio','text'],
        input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 },
        output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 }
      }
    }));
  });

  openaiWS.on('message', (data) => {
    // OpenAI realtime emits JSON control and audio chunks (base64 in "delta")
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {}
    if (!msg) return;

    if (msg.type === 'response.output_audio.delta' && msg.delta) {
      // NOTE: We are not sending audio back to Twilio right now because your TwiML
      // uses inbound-only audio (no outbound track). This keeps it stable while we verify ingest.
      // Once you switch to a bidirectional stream, we can forward these deltas back.
    }

    if (msg.type === 'error') {
      console.error('OpenAI ERROR:', msg);
    }
  });

  openaiWS.on('close', () => {
    console.log('🔚 OpenAI WS closed');
    try { twilioWS.close(); } catch {}
  });

  openaiWS.on('error', (err) => {
    console.error('OpenAI WS error:', err);
  });

  // Receive Twilio media messages and forward audio to OpenAI
  // Twilio will send JSON frames; media payload is base64 μ-law @ 8kHz
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'connected') {
        console.log('Twilio event: connected');
      }

      if (msg.event === 'start') {
        console.log('▶️ media START {', `streamSid: ${msg.start?.streamSid}`, '}');
        // Prepare an input_audio buffer on OpenAI
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.create' }));
      }

      if (msg.event === 'media' && msg.media && msg.media.payload) {
        // Append base64 μ-law audio chunk
        openaiWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      if (msg.event === 'stop') {
        console.log('⏹️ media STOP', msg.streamSid || '');
        // Commit the audio so OpenAI can process a response
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        // Ask for a response (it will produce text+audio on its side)
        openaiWS.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: 'Say hello briefly.' }
        }));
      }
    } catch (e) {
      console.error('Twilio msg parse error:', e);
    }
  });

  twilioWS.on('close', (code) => {
    console.log('🔚 Twilio WS closed', code || '');
    try { openaiWS.close(); } catch {}
  });

  twilioWS.on('error', (err) => {
    console.error('Twilio WS error:', err);
    try { openaiWS.close(); } catch {}
  });
}

server.listen(PORT, () => {
  console.log('==> Your service is live 🎉');
  console.log('==> ////////////////////////////////////////////////////');
  console.log('==> Available at your primary URL https://barber-ai.onrender.com');
  console.log('==> ////////////////////////////////////////////////////');
});
