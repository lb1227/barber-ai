// Minimal Twilio -> OpenAI Realtime TALK test
// Goal: prove OpenAI can speak "Hello, you are connected to Barber AI."

const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const PORT = process.env.PORT || 10000;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("OK"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

wss.on("connection", (twilioWS) => {
  const tag = Math.random().toString(36).slice(2, 6);
  log(`[${tag}] Twilio connected`);

  const aiURL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
  const aiWS = new WebSocket(aiURL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  // --- OpenAI lifecycle ---
  aiWS.on("open", () => {
    log(`[${tag}] ✅ OpenAI WS open`);

    // Tell it to use voice + μ-law output
    aiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio"],        // audio only
        voice: "alloy",               // a valid voice
        output_audio_format: "g711_ulaw"
      }
    }));

    // Create a one-line response
    aiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hello, you are connected to Barber AI."
      }
    }));
  });

  aiWS.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    // forward audio chunks to Twilio
    if (data.type === "response.audio.delta" && data.delta) {
      twilioWS.send(JSON.stringify({
        event: "media",
        media: { payload: data.delta }
      }));
    }

    if (data.type === "response.completed") {
      log(`[${tag}] ✅ Response completed, closing soon`);
      setTimeout(() => {
        try { twilioWS.close(); } catch {}
        try { aiWS.close(); } catch {}
      }, 500);
    }

    if (data.type === "error") {
      log(`[${tag}] ❌ OpenAI ERROR`, data);
    }
  });

  aiWS.on("close", () => log(`[${tag}] OpenAI closed`));
  aiWS.on("error", (err) => log(`[${tag}] OpenAI error:`, err));

  // --- Twilio lifecycle ---
  twilioWS.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === "connected") log(`[${tag}] Twilio WS connected`);
    if (data.event === "start") log(`[${tag}] Twilio start`);
    if (data.event === "stop") {
      log(`[${tag}] Twilio stop`);
      aiWS.close();
      twilioWS.close();
    }
  });

  twilioWS.on("close", () => log(`[${tag}] Twilio closed`));
  twilioWS.on("error", (err) => log(`[${tag}] Twilio error:`, err));
});

server.listen(PORT, () => {
  console.log("==> Minimal server live at", `https://barber-ai.onrender.com`);
});
