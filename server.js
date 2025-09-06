const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { VoiceResponse } } = require('twilio');

const PORT = process.env.PORT || 10000;
const VOICE = process.env.POLLY_VOICE || 'Polly.Matthew'; // fallback to Polly voice if you like
// You can also use 'alice' or 'man'/'woman' if Polly isn't enabled on your account.

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health
app.get('/', (req, res) => res.status(200).send('OK'));

// Return well-formed TwiML quickly. Accept GET *and* POST to avoid mismatch.
app.all('/voice', (req, res) => {
  try {
    const vr = new VoiceResponse();

    // TALK ONLY: Always speak, then hang up (keep this first to prove end-to-end audio).
    // Once you confirm you can hear this, we can switch to Gather or AI again.
    const say = vr.say({ voice: VOICE, language: 'en-US' },
      "Hey! You're through to Barber A I. This is a talking-only test from the webhook. " +
      "If you can hear me, the webhook is working. Goodbye for now."
    );

    vr.pause({ length: 1 });
    vr.hangup();

    const xml = vr.toString();
    res.type('text/xml').status(200).send(xml);
  } catch (err) {
    console.error('[ /voice ERROR ]', err);
    // Even on error, return TwiML so Twilio never gets a blank/500.
    const vr = new VoiceResponse();
    vr.say("Sorry, something went wrong on our end. Please try again.");
    vr.hangup();
    res.type('text/xml').status(200).send(vr.toString());
  }
});

// Optional: simple Gather endpoint (not used yet)
app.all('/gather', (req, res) => {
  const vr = new VoiceResponse();
  vr.say({ voice: VOICE }, "Thanks, test gather received.");
  vr.hangup();
  res.type('text/xml').status(200).send(vr.toString());
});

app.listen(PORT, () => {
  console.log(`✅ Voice-min server listening on ${PORT}`);
});
