import 'dotenv/config';
import express from 'express';

const app = express();

// This is where Twilio will send calls
app.post('/voice', (req, res) => {
  const twiml = `
    <Response>
      <Say voice="alice">Hi, thanks for calling the barber shop. This is our test line.</Say>
    </Response>
  `;
  res.type('text/xml').send(twiml.trim());
});

app.listen(3000, () => console.log('Server running on port 3000'));
