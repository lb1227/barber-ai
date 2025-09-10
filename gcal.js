// gcal.js
import { google } from "googleapis";
import fs from "fs";

const TOKEN_PATH = "./gcal_token.json";

export function getOAuth() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  } = process.env;

  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
  }
  return oAuth2Client;
}

export function getAuthUrl() {
  const oAuth2Client = getOAuth();
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar"
    ],
  });
}

export async function saveCodeExchange(code) {
  const oAuth2Client = getOAuth();
  const { tokens } = await oAuth2Client.getToken(code);
  // Persist refresh token
  const merged = { ...tokens };
  fs.writeFileSync("./gcal_token.json", JSON.stringify(merged, null, 2));
  oAuth2Client.setCredentials(merged);
  return true;
}

function calendarClient() {
  const auth = getOAuth();
  return google.calendar({ version: "v3", auth });
}

export async function checkAvailability({ startISO, endISO, calendarId }) {
  const cal = calendarClient();
  const body = {
    timeMin: startISO,
    timeMax: endISO,
    timeZone: process.env.BUSINESS_TIMEZONE || "UTC",
    items: [{ id: calendarId }],
  };
  const { data } = await cal.freebusy.query({ requestBody: body });
  const busy = data?.calendars?.[calendarId]?.busy || [];
  return { busy }; // [] means free
}

export async function createEvent({ calendarId, summary, description, startISO, endISO, attendees = [] }) {
  const cal = calendarClient();
  const { data } = await cal.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: process.env.BUSINESS_TIMEZONE || "UTC" },
      end:   { dateTime: endISO,   timeZone: process.env.BUSINESS_TIMEZONE || "UTC" },
      attendees,
    },
  });
  return { id: data.id, htmlLink: data.htmlLink };
}

export async function moveEvent({ calendarId, eventId, startISO, endISO }) {
  const cal = calendarClient();
  const { data } = await cal.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: { dateTime: startISO, timeZone: process.env.BUSINESS_TIMEZONE || "UTC" },
      end:   { dateTime: endISO,   timeZone: process.env.BUSINESS_TIMEZONE || "UTC" },
    },
  });
  return { id: data.id, htmlLink: data.htmlLink };
}

export async function cancelEvent({ calendarId, eventId }) {
  const cal = calendarClient();
  await cal.events.delete({ calendarId, eventId });
  return { ok: true };
}
