import db from "./database.js";
import 'dotenv/config';
import express from 'express';

const app = express();

// Parse JSON request bodies
app.use(express.json());

/**
 * Simple helper: validate basic appointment payload
 */
function validateAppointmentPayload(body) {
  const { customer_name, phone_number, appointment_time } = body || {};
  if (!customer_name || !phone_number || !appointment_time) {
    return { ok: false, message: "Missing fields. Required: customer_name, phone_number, appointment_time" };
  }
  // very light sanity check – you can harden this later
  // Expecting "YYYY-MM-DD HH:mm"
  if (!/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(appointment_time)) {
    return { ok: false, message: "Invalid appointment_time format. Use YYYY-MM-DD HH:mm (24h)." };
  }
  return { ok: true };
}

/**
 * Check if a time slot is already taken (simple 1:1 conflict)
 * You can extend to 30-min blocks, staff per chair, etc.
 */
function isTimeBooked(appointment_time, excludeId = null) {
  const row = excludeId
    ? db.prepare(
        `SELECT id FROM appointments WHERE appointment_time = ? AND id != ?`
      ).get(appointment_time, excludeId)
    : db.prepare(
        `SELECT id FROM appointments WHERE appointment_time = ?`
      ).get(appointment_time);
  return !!row;
}

/**
 * HOME (optional)
 */
app.get('/', (_req, res) => {
  res.send('Barber AI API is running ✂️');
});

/**
 * ===== Appt routes =====
 */

// List all appointments (optionally filter by phone)
app.get('/appointments', (req, res) => {
  const { phone } = req.query;
  try {
    if (phone) {
      const rows = db.prepare(
        `SELECT id, customer_name, phone_number, appointment_time
         FROM appointments
         WHERE phone_number = ?
         ORDER BY appointment_time ASC`
      ).all(phone);
      return res.json(rows);
    }

    const rows = db.prepare(
      `SELECT id, customer_name, phone_number, appointment_time
       FROM appointments
       ORDER BY appointment_time ASC`
    ).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "DB error", details: err.message });
  }
});

// Get one by ID
app.get('/appointments/:id', (req, res) => {
  try {
    const row = db.prepare(
      `SELECT id, customer_name, phone_number, appointment_time
       FROM appointments WHERE id = ?`
    ).get(req.params.id);

    if (!row) return res.status(404).json({ error: "Appointment not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "DB error", details: err.message });
  }
});

// Create a new appointment
app.post('/make-appointment', (req, res) => {
  const check = validateAppointmentPayload(req.body);
  if (!check.ok) return res.status(400).json({ success: false, error: check.message });

  const { customer_name, phone_number, appointment_time } = req.body;

  try {
    if (isTimeBooked(appointment_time)) {
      return res.status(409).json({
        success: false,
        error: "That time is already booked. Please choose a different time."
      });
    }

    const info = db.prepare(
      `INSERT INTO appointments (customer_name, phone_number, appointment_time)
       VALUES (?, ?, ?)`
    ).run(customer_name, phone_number, appointment_time);

    return res.json({ success: true, id: info.lastInsertRowid, message: "Appointment booked!" });
  } catch (err) {
    res.status(500).json({ success: false, error: "DB insert error", details: err.message });
  }
});

// Update / reschedule
app.put('/appointments/:id', (req, res) => {
  const id = Number(req.params.id);
  const { customer_name, phone_number, appointment_time } = req.body || {};

  if (!customer_name && !phone_number && !appointment_time) {
    return res.status(400).json({
      success: false,
      error: "Provide at least one of: customer_name, phone_number, appointment_time"
    });
  }

  // If appointment_time is provided, validate & check conflicts
  if (appointment_time) {
    const fmt = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/;
    if (!fmt.test(appointment_time)) {
      return res.status(400).json({ success: false, error: "Invalid appointment_time format (YYYY-MM-DD HH:mm)" });
    }
    if (isTimeBooked(appointment_time, id)) {
      return res.status(409).json({
        success: false,
        error: "That time is already booked. Please choose a different time."
      });
    }
  }

  try {
    // Build dynamic update
    const fields = [];
    const params = [];

    if (customer_name) { fields.push("customer_name = ?"); params.push(customer_name); }
    if (phone_number)   { fields.push("phone_number = ?");   params.push(phone_number); }
    if (appointment_time){fields.push("appointment_time = ?");params.push(appointment_time); }

    if (!fields.length) {
      return res.status(400).json({ success: false, error: "Nothing to update" });
    }

    params.push(id);

    const stmt = db.prepare(`UPDATE appointments SET ${fields.join(", ")} WHERE id = ?`);
    const info = stmt.run(...params);

    if (info.changes === 0) {
      return res.status(404).json({ success: false, error: "Appointment not found" });
    }

    res.json({ success: true, message: "Appointment updated." });
  } catch (err) {
    res.status(500).json({ success: false, error: "DB update error", details: err.message });
  }
});

// Delete / cancel
app.delete('/appointments/:id', (req, res) => {
  try {
    const info = db.prepare(`DELETE FROM appointments WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) {
      return res.status(404).json({ success: false, error: "Appointment not found" });
    }
    res.json({ success: true, message: "Appointment cancelled." });
  } catch (err) {
    res.status(500).json({ success: false, error: "DB delete error", details: err.message });
  }
});

/**
 * ===== Test route to confirm DB connectivity =====
 * (kept from earlier)
 */
app.get('/test-db', (_req, res) => {
  try {
    const rowCount = db.prepare("SELECT COUNT(*) as count FROM appointments").get();
    res.send(`Database is working ✅. Appointments stored: ${rowCount.count}`);
  } catch (err) {
    res.status(500).send("Database error ✖ " + err.message);
  }
});

/**
 * ===== Twilio webhook (unchanged for now; we’ll expand next) =====
 */
app.post('/voice', (req, res) => {
  const twiml = `
    <Response>
      <Say voice="alice">Hi, thanks for calling the barber shop. This is our test line.</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

app.listen(3000, () => console.log('Server running on port 3000'));
