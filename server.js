import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const BASE_URL = process.env.BASE_URL || "https://barber-ai.onrender.com";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

// crash visibility
process.on("uncaughtException", (err) => console.error("[Uncaught]", err));
process.on("unhandledRejection", (err) => console.error("[Unhandled]", err));

const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    const twiml = `
      <Response>
        <Say voice="alice">Starting inbound stream.</Say>
        <Connect>
          <Stream url="wss://barber-ai.onrender.com/media" track="inbound_track"/>
        </Connect>
      </Response>
    `.trim();

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml);
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Barber AI Realtime bridge is alive.\n");
});

// ✅ add lightweight HTTP/WS logs AFTER the server exists
server.on("request", (req) => {
  console.log("[HTTP]", req.method, req.url, "ua=", req.headers["user-agent"]);
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false, // optional: avoids rare negotiation issues
});

server.on("upgrade", (req, socket, head) => {
  console.log("[UPGRADE]", req.url, "ua=", req.headers["user-agent"], "xfwd=", req.headers["x-forwarded-for"]);
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWS) => {
  console.log("[Twilio] connected");

  // ---- state/guards --------------------------------------------------------
  let twilioReady = false;
  let streamSid = null;
  let inboundBytes = 0;
  let hasInboundAudio = false;
  let isSpeaking = false;
  let awaitingCancel = false;
  let awaitingResponse = false; // response currently in flight
  let greetingInFlight = false; // initial greeting turn
  const pendingAudio = [];
  
  const safeSendTwilio = (msgObj) => {
    if (!twilioReady || !streamSid) {
      if (msgObj?.event === "media") pendingAudio.push(msgObj);
      return;
    }
    // ensure streamSid is on every media frame
    if (msgObj?.event === "media" && !msgObj.streamSid) {
      msgObj.streamSid = streamSid;
    }
    if (twilioWS.readyState === WebSocket.OPEN) {
      try {
        twilioWS.send(JSON.stringify(msgObj));
      } catch (err) {
        console.error("[Twilio send error]", err);
      }
    }
  };

  const flushPendingAudio = () => {
    while (pendingAudio.length && twilioWS.readyState === WebSocket.OPEN) {
      const frame = pendingAudio.shift();
      // reuse the same path that injects streamSid
      safeSendTwilio(frame);
    }
  };


  // ---- OpenAI client socket ------------------------------------------------
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_REALTIME_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        "x-openai-audio-output-format": "g711_ulaw",
      },
    }
  );
  
  let openaiOutbox = [];
  const safeSendOpenAI = (objOrString) => {
    const data = typeof objOrString === "string" ? objOrString : JSON.stringify(objOrString);
    if (openaiWS.readyState === WebSocket.OPEN) {
      try { openaiWS.send(data); } catch (e) { console.error("[OpenAI send error]", e); }
    } else {
      openaiOutbox.push(data);
    }
  };
  
  openaiWS.on("open", () => {
    console.log("[OpenAI] WS open");
    safeSendOpenAI({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        output_audio_format: "g711_ulaw",  // Twilio playback
        input_audio_format: "g711_ulaw",   // Twilio inbound audio format
        turn_detection: {                   // Server VAD
          type: "server_vad",
          threshold: 0.5,
          silence_duration_ms: 500,
          prefix_padding_ms: 200
        },
        instructions:
          "You are Barber AI. Always speak concise US English for phone calls."
      },
    });
  
    // Flush queued messages
    while (openaiOutbox.length) openaiWS.send(openaiOutbox.shift());
  });


  // Forward OpenAI audio -> Twilio (buffer until Twilio ready)
  openaiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!["response.output_audio.delta", "error"].includes(msg.type)) {
        console.log("[OpenAI EVENT]", msg.type, JSON.stringify(msg).slice(0, 400));
      }
  
      if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
        isSpeaking = true;
        const payload = msg.audio || msg.delta; // base64 μ-law
        safeSendTwilio({ event: "media", media: { payload } });
        if (streamSid) safeSendTwilio({ event: "mark", streamSid, mark: { name: "chunk" } });
      }
      else if (msg.type === "response.audio.done") {
        isSpeaking = false;
        awaitingCancel = false;
      }
      else if (msg.type === "response.canceled") {
        isSpeaking = false;
        awaitingCancel = false;
        // awaitingResponse clears on response.done
      }
      else if (msg.type === "response.done") {
        isSpeaking = false;
        awaitingCancel = false;
        awaitingResponse = false;
        if (greetingInFlight) {
          console.log("[State] greeting done");
          greetingInFlight = false;
        }
      }
      else if (msg.type === "error") {
        console.error("[OpenAI ERROR]", msg);
      }

    } catch (e) {
      console.error("OpenAI message parse error", e);
    }
  });



  // ---- Twilio inbound ------------------------------------------------------
  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
  
      if (msg.event === "media") {
        if (isSpeaking && awaitingResponse && !awaitingCancel) {
          safeSendOpenAI({ type: "response.cancel" });
          awaitingCancel = true;
        }
      
        const b64 = msg.media?.payload;
        if (b64) {
          hasInboundAudio = true;
          inboundBytes += Buffer.from(b64, "base64").length;
          safeSendOpenAI({ type: "input_audio_buffer.append", audio: b64 });
          pendingCommit = true;
          startCommitTimerIfNeeded();
        }
        return;
      }



  
      if (msg.event === "start") {
        console.log("[Twilio] stream start:", msg.start.streamSid, "tracks:", msg.start.tracks);
        streamSid = msg.start.streamSid;
        twilioReady = true;
        flushPendingAudio?.();
      
        // treat greeting as an active response
        greetingInFlight = true;
        awaitingResponse = true;
        console.log("[Greeting] response.create");
      
        safeSendOpenAI({
          type: "response.create",
          response: {
            instructions:
              "Say exactly: 'Hello from Barber AI. If you can hear this, the OpenAI link works.'",
            modalities: ["audio", "text"],
            conversation: "none",
          },
        });
        return;
      }
  
      if (msg.event === "mark") {
        console.log("[Twilio] mark received:", msg?.mark?.name);
        return;
      }
  
      if (msg.event === "stop") {
        console.log("[Twilio] stop");
        safeClose(openaiWS);
        safeClose(twilioWS);
        return;
      }
  
    } catch (e) {
      console.error("Twilio message parse error", e);
    }
  });
  


  const COMMIT_THRESHOLD = 2000; // ~200–250ms μ-law
    const COMMIT_MS = 150;
    let commitTimer = null;
    let pendingCommit = false;
    
    function startCommitTimerIfNeeded() {
      if (commitTimer) return;
      commitTimer = setInterval(() => {
        if (!hasInboundAudio) return;
        if (openaiWS.readyState !== WebSocket.OPEN) return;
    
        if (pendingCommit &&
            inboundBytes >= COMMIT_THRESHOLD &&
            !awaitingResponse &&
            !greetingInFlight) {
          console.log("[Commit] sending with", inboundBytes, "bytes");
          safeSendOpenAI({ type: "input_audio_buffer.commit" });
          safeSendOpenAI({
            type: "response.create",
            response: { modalities: ["audio", "text"], conversation: "auto" },
          });
          awaitingResponse = true;
          inboundBytes = 0;
          pendingCommit = false;
        }
      }, COMMIT_MS);
    }
  
  function stopCommitTimer() {
    if (commitTimer) {
      clearInterval(commitTimer);
      commitTimer = null;
    }
  }
  
  twilioWS.on("close", () => {
    console.log("[Twilio] closed");
    stopCommitTimer();
    safeClose(openaiWS);
  });
  openaiWS.on("close", () => {
    console.log("[OpenAI] closed");
    stopCommitTimer();
    safeClose(twilioWS);
  });



  twilioWS.on("error", (e) => console.error("[Twilio WS error]", e));
  openaiWS.on("error", (e) => console.error("[OpenAI WS error]", e));
});

server.listen(PORT, () => {
  console.log(`Minimal WS server ready at http://0.0.0.0:${PORT}`);
});

function safeClose(ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch {}
}
