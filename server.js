// server.js  — Twilio Media Streams loopback (echo) test
// If you call your Twilio number and speak, you should hear yourself.

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 10000;
const app = express();

// simple health check
app.get("/", (_req, res) => res.status(200).send("OK"));

// create HTTP server and attach WS upgrade handler
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Twilio will connect to wss://<host>/media
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  let streamSid = null;

  const safeSend = (obj) => {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  };

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const { event } = data;

    if (event === "start") {
      streamSid = data.start?.streamSid || data.streamSid;
      console.log("[Twilio] START", { streamSid });
      return;
    }

    if (event === "media") {
      // Echo back the exact μ-law frame we got from Twilio
      if (data.media?.payload && streamSid) {
        safeSend({
          event: "media",
          streamSid,
          media: { payload: data.media.payload },
        });
      }
      return;
    }

    if (event === "mark") {
      // just acknowledge marks
      return;
    }

    if (event === "stop") {
      console.log("[Twilio] STOP", { streamSid: data.stop?.streamSid || streamSid });
      try { ws.close(1000); } catch (_) {}
      return;
    }
  });

  ws.on("close", () => console.log("[Twilio] WS closed"));
  ws.on("error", (err) => console.error("[Twilio] WS error", err));

  // keep-alive: send a mark every 5s so Twilio knows we're alive
  const interval = setInterval(() => {
    if (ws.readyState === ws.OPEN && streamSid) {
      safeSend({ event: "mark", streamSid, mark: { name: "echo-alive" } });
    }
  }, 5000);

  ws.on("close", () => clearInterval(interval));
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
