import db from "./database.js";
import 'dotenv/config';
import express from 'express';

const app = express();

// --- Twilio entry point (kept simple for now) ---
app.post('/voice', (req, res) => {
  const twiml = `
    <Response>
      <Say voice="alice">Hi, thanks for calling the barber shop. This is our test line.</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

// --- Test route: verify database connectivity and row count ---
app.get('/test-db', (req, res) => {
  try {
    const rowCount = db.prepare("SELECT COUNT(*) as count FROM appointments").get();
    res.send(`Database is working ✅. Appointments stored: ${rowCount.count}`);
  } catch (err) {
    res.status(500).send("Database error ❌ " + err.message);
  }
});

// --- Test route: insert a sample appointment row ---
app.get('/make-appointment-test', (req, res) => {
  try {
    const stmt = db.prepare(
      'INSERT INTO appointments (customer_name, phone_number, appointment_time) VALUES (?, ?, ?)'
    );
    const id = stmt.run('Test User', '+18136074989', new Date().toISOString()).lastInsertRowid;
    res.send(`Inserted test appointment with id ${id} ✅`);
  } catch (err) {
    res.status(500).send('Insert failed ❌ ' + err.message);
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
