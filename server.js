// server.js  — Twilio Media Streams echo test (μ-law passthrough)
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

// WebSocket endpoint only for /media
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio connected");

  // We keep the active streamSid from the "start" event
  let streamSid = null;

  twilioWs.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      // Log event types so you can see the flow
      if (evt.event) console.log("🎯 Twilio event:", evt.event);

      if (evt.event === "start") {
        // Save the streamSid we'll need to send audio back
        streamSid = evt.start?.streamSid;
        console.log("📞 Call started", evt.start);
      }

      if (evt.event === "media") {
        // Inbound audio frame from Twilio (μ-law base64)
        const payload = evt.media?.payload;
        if (!payload || !streamSid) return;

        // 🔁 Echo: send the same μ-law frame back to Twilio immediately
        const out = {
          event: "media",
          streamSid,
          media: { payload },
        };
        // IMPORTANT: send back as a single JSON line
        twilioWs.send(JSON.stringify(out));
      }

      if (evt.event === "stop") {
        console.log("🛑 Call ended");
        streamSid = null;
      }
    } catch (e) {
      console.error("❌ Parse error", e);
    }
  });

  twilioWs.on("close", () => console.log("❎ Twilio WS closed"));
  twilioWs.on("error", (err) => console.error("⚠️ Twilio WS error", err));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("🚀 Server running on", PORT));
