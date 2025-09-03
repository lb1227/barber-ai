// server.js
import db from "./database.js";
import "dotenv/config";
import express from "express";

const app = express();

// Parse JSON request bodies (needed for /make-appointment)
app.use(express.json());

/**
 * Twilio webhook (still your test response for now)
 * You can point your Twilio number's Voice URL to: https://barber-ai.onrender.com/voice
 */
app.post("/voice", (req, res) => {
  const twiml = `
    <Response>
      <Say voice="alice">Hi, thanks for calling the barber shop. This is our test line.</Say>
    </Response>
  `;
  res.type("text/xml").send(twiml.trim());
});

/**
 * ✅ DB health check
 * Quick way to confirm the service can read the appointments table
 */
app.get("/test-db", (req, res) => {
  try {
    const rowCount = db
      .prepare("SELECT COUNT(*) as count FROM appointments")
      .get();
    res.send(
      `Database is working ✅. Appointments stored: ${rowCount.count}`
    );
  } catch (err) {
    res.status(500).send("Database error ✖ " + err.message);
  }
});

/**
 * 🗓️ Create an appointment
 * POST /make-appointment
 * Body: { "customer_name": "...", "phone_number": "...", "appointment_time": "YYYY-MM-DD HH:mm" }
 */
app.post("/make-appointment", (req, res) => {
  try {
    const { customer_name, phone_number, appointment_time } = req.body || {};

    // Basic validation
    if (!customer_name || !phone_number || !appointment_time) {
      return res.status(400).json({
        success: false,
        error:
          "Missing fields. Required: customer_name, phone_number, appointment_time",
      });
    }

    const stmt = db.prepare(
      `INSERT INTO appointments (customer_name, phone_number, appointment_time)
       VALUES (?, ?, ?)`
    );
    stmt.run(customer_name, phone_number, appointment_time);

    return res.json({ success: true, message: "Appointment booked!" });
  } catch (err) {
    console.error("make-appointment error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Server error: " + err.message });
  }
});

/**
 * (Optional) simple list endpoint for quick verification in browser
 * GET /appointments
 */
app.get("/appointments", (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT id, customer_name, phone_number, appointment_time
         FROM appointments
         ORDER BY appointment_time ASC`
      )
      .all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
