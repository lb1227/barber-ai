import db from "./database.js";
import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json()); // in case we missed it

// --- Twilio test route (unchanged) ---
app.post('/voice', (req, res) => {
  const twiml = `
    <Response>
      <Say voice="alice">Hi, thanks for calling the barber shop. This is our test line.</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

// --- Health check for DB (unchanged) ---
app.get('/test-db', (req, res) => {
  try {
    const rowCount = db.prepare('SELECT COUNT(*) AS count FROM appointments').get();
    res.send(`Database is working ✓. Appointments stored: ${rowCount.count}`);
  } catch (err) {
    res.status(500).send('Database error ✗ ' + err.message);
  }
});

/* =========================
   Appointments API
   ========================= */

// Create
app.post('/make-appointment', (req, res) => {
  const { customer_name, phone_number, appointment_time } = req.body || {};
  if (!customer_name || !phone_number || !appointment_time) {
    return res.status(400).json({
      success: false,
      error: 'Missing fields. Required: customer_name, phone_number, appointment_time'
    });
  }

  try {
    db.prepare(`
      INSERT INTO appointments (customer_name, phone_number, appointment_time)
      VALUES (?, ?, ?)
    `).run(customer_name, phone_number, appointment_time);

    return res.json({ success: true, message: 'Appointment booked!' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// List (all or by phone)
app.get('/appointments', (req, res) => {
  const { phone } = req.query;
  try {
    if (phone) {
      const rows = db.prepare(
        `SELECT * FROM appointments WHERE phone_number = ? ORDER BY id DESC`
      ).all(phone);
      return res.json(rows);
    } else {
      const rows = db.prepare(`SELECT * FROM appointments ORDER BY id DESC`).all();
      return res.json(rows);
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET one by id  ← ensure we read :id and coerce to Number
app.get('/appointments/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const row = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Update by id
app.put('/appointments/:id', (req, res) => {
  const id = Number(req.params.id);
  const { appointment_time } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }
  if (!appointment_time) {
    return res.status(400).json({ success: false, error: 'appointment_time is required' });
  }

  try {
    const { changes } = db.prepare(
      `UPDATE appointments SET appointment_time = ? WHERE id = ?`
    ).run(appointment_time, id);

    if (changes === 0) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }
    return res.json({ success: true, message: 'Appointment updated' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Delete by id
app.delete('/appointments/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  try {
    const { changes } = db.prepare(`DELETE FROM appointments WHERE id = ?`).run(id);
    if (changes === 0) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }
    return res.json({ success: true, message: 'Appointment deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
