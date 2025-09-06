const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { VoiceResponse } } = require('twilio');

const PORT = process.env.PORT || 10000;
const VOICE = process.env.POLLY_VOICE || 'alice'; // 'alice' works on all accounts

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (req, res) => res.status(200).send('OK'));

app.all('/voice', (req, res) => {
  try {
    const vr = new VoiceResponse();
    vr.say({ voice: VOICE, language: 'en-US' },
      "Hey! You're through to the Barber A I test. " +
      "This is the minimal webhook talking. " +
      "If you hear this, we are good. Goodbye."
    );
    vr.pause({ length: 1 });
    vr.hangup();

    res.type('text/xml').status(200).send(vr.toString());
  } catch (err) {
    console.error('[ /voice ERROR ]', err);
    const vr = new VoiceResponse();
    vr.say("Sorry, something went wrong on our end.");
    vr.hangup();
    res.type('text/xml').status(200).send(vr.toString());
  }
});

app.listen(PORT, () => console.log(`✅ Voice-min server listening on ${PORT}`));
