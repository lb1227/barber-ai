// server.js — Twilio Stream status-callback logger (ESM)
import express from "express";
import http from "http";

const app = express();
const server = http.createServer(app);

// Parse JSON bodies from Twilio status callbacks
app.use(express.json({ limit: "1mb" }));

// Log every HTTP request (so we see Twilio hitting anything at all)
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url} UA=${req.headers["user-agent"] || "-"}`);
  next();
});

// Health check
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Twilio <Stream> statusCallback receiver
// Twilio will POST here with fields like: event, status, streamSid, accountSid, callSid, error, message, etc.
app.post("/twilio-status", (req, res) => {
  console.log("==== Twilio STATUS CALLBACK ====");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("================================");
  res.status(200).send("received");
});

// Root
app.get("/", (_req, res) => res.status(200).send("OK: root"));

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
