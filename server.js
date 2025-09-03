// server.js
import express from 'express';
import 'dotenv/config';
import db from './database.js';

const app = express();                 // ✅ make sure app exists before using it
app.use(express.json());

// -----------------------------
// Twilio Voice webhook (basic)
// -----------------------------
app.post('/voice', (req, res) => {
  // Simple TwiML that listens for speech
  // (we’ll enhance the conversational flow after this builds cleanly)
  const twiml = `
    <Response>
      <Gather input="speech" action="/voice/handle" method="POST" speechTimeout="auto">
        <Say voice="Polly.Joanna">
          Hello, thanks for calling the barber shop.
          You can say things like book an appointment, cancel, or reschedule.
          How can I help you today?
        </Say>
      </Gather>
      <Say voice="Polly.Joanna">Sorry, I didn't get that.</Say>
      <Redirect>/voice</Redirect>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

// Basic handler to echo what was heard (placeholder you can improve later)
app.post('/voice/handle', (req, res) => {
  const twiml = `
    <Response>
      <Say voice="Polly.Joanna">
        Thanks! I heard you. This part will be wired into smart conversation next.
      </Say>
      <Hangup/>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

// -----------------------------
// DB sanity route
// -----------------------------
app.get('/test-db', (req, res) => {
  try {
    const rowCount = db.prepare('SELECT COUNT(*) AS count FROM appointments').get();
    res.send(`Database is working. Appointments stored: ${rowCount.count}`);
  } catch (err) {
    res.status(500).send('Database error: ' + err.message);
  }
});

// -----------------------------
// CRUD: Appointments
// -----------------------------
app.post('/make-appointment', (req, res) => {
  const { customer_name, phone_number, appointment_time } = req.body || {};
  if (!customer_name || !phone_number || !appointment_time) {
    return res.status(400).json({
      success: false,
      error: 'Missing fields. Required: customer_name, phone_number, appointment_time',
    });
  }
  const stmt = db.prepare(`
    INSERT INTO appointments (customer_name, phone_number, appointment_time)
    VALUES (?, ?, ?)
  `);
  stmt.run(customer_name, phone_number, appointment_time);
  res.json({ success: true, message: 'Appointment booked!' });
});

app.get('/appointments', (req, res) => {
  const { phone } = req.query;
  if (phone) {
    const rows = db.prepare('SELECT * FROM appointments WHERE phone_number = ?').all(phone);
    return res.json(rows);
  }
  const rows = db.prepare('SELECT * FROM appointments').all();
  res.json(rows);
});

app.get('/appointments/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!row) return res.json({ success: false, error: 'Appointment not found' });
  res.json(row);
});

app.put('/appointments/:id', (req, res) => {
  const id = Number(req.params.id);
  const { customer_name, phone_number, appointment_time } = req.body || {};
  const row = db.prepare('SELECT id FROM appointments WHERE id = ?').get(id);
  if (!row) return res.json({ success: false, error: 'Appointment not found' });

  const update = db.prepare(`
    UPDATE appointments
       SET customer_name = COALESCE(?, customer_name),
           phone_number = COALESCE(?, phone_number),
           appointment_time = COALESCE(?, appointment_time)
     WHERE id = ?
  `);
  update.run(customer_name ?? null, phone_number ?? null, appointment_time ?? null, id);
  res.json({ success: true, message: 'Appointment updated' });
});

app.delete('/appointments/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
  if (info.changes === 0) return res.json({ success: false, error: 'Appointment not found' });
  res.json({ success: true, message: 'Appointment deleted' });
});

// -----------------------------
// Health check
// -----------------------------
app.get('/health', (_req, res) => res.send('ok'));

// -----------------------------
// Start server (Render uses process.env.PORT)
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
