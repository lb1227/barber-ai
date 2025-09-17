// gcal.js
import { google } from "googleapis";
import fs from "fs";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI, // e.g. https://barber-ai.onrender.com/oauth2callback
  GOOGLE_CALENDAR_ID,  // preferred env var
  CALENDAR_ID: LEGACY_CALENDAR_ID, // fallback name
} = process.env;

// Use GOOGLE_CALENDAR_ID if present, else CALENDAR_ID, else "primary"
const CALENDAR_ID = GOOGLE_CALENDAR_ID || LEGACY_CALENDAR_ID || "primary";

const TOKEN_PATH = "./google_tokens.json";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar",
  "openid",
  "email",
  "https://www.googleapis.com/auth/userinfo.email",
];

function createOAuth2() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Missing Google OAuth env vars");
  }
  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  // Load tokens from disk if present
  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oauth2.setCredentials(tokens);
  }
  // Persist refresh token updates
  oauth2.on("tokens", (t) => {
    const current = fs.existsSync(TOKEN_PATH)
      ? JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"))
      : {};
    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify({ ...current, ...t }, null, 2),
      "utf8"
    );
  });
  return oauth2;
}

export function getAuthUrl() {
  const oauth2 = createOAuth2();
  return oauth2.generateAuthUrl({
    access_type: "offline", // get refresh_token
    prompt: "consent",      // ensure refresh_token on repeated connects
    scope: SCOPES,
    redirect_uri: GOOGLE_REDIRECT_URI, // explicit to avoid mismatch
  });
}

export async function handleOAuthCallback(code) {
  const oauth2 = createOAuth2();
  const { tokens } = await oauth2.getToken({
    code,
    redirect_uri: GOOGLE_REDIRECT_URI, // explicit to avoid mismatch
  });
  oauth2.setCredentials(tokens);
  // Save immediately
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
  return true;
}

function calendarClient() {
  const auth = createOAuth2();
  return google.calendar({ version: "v3", auth });
}

export async function whoAmI() {
  try {
    const auth = createOAuth2();
    const oauth2 = google.oauth2({ version: "v2", auth });
    const { data } = await oauth2.userinfo.get();
    return data;
  } catch (e) {
    console.error("[whoAmI] error", e?.response?.data || e);
    throw e;
  }
}

export async function listEventsToday() {
  const cal = calendarClient();
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const { data } = await cal.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 25,
  });
  return data.items || [];
}

function audit(type, payload) {
  const entry = { ts: new Date().toISOString(), type, ...payload };
  fs.appendFile("audit.log", JSON.stringify(entry) + "\n", () => {});
}

export async function createEvent({ summary, start, end, attendees = [], description = "" }) {
  const calendar = calendarClient();
  try {
    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary,
        description,
        start: { dateTime: start },
        end: { dateTime: end },
        attendees: attendees.map((email) => ({ email })),
      },
    });

    const ev = res.data;
    console.log(
      "[GCAL] created",
      ev.id,
      "summary=", ev.summary,
      "start=", ev.start?.dateTime,
      "end=", ev.end?.dateTime,
      "attendees=", (ev.attendees || []).map((a) => a.email).join(",")
    );
    audit("gcal.create", {
      id: ev.id,
      summary: ev.summary,
      start: ev.start?.dateTime,
      end: ev.end?.dateTime,
      attendees: (ev.attendees || []).map((a) => a.email),
      htmlLink: ev.htmlLink,
    });

    return ev;
  } catch (err) {
    console.error("[GCAL] create error:", err?.response?.data || err.message);
    audit("gcal.error", { op: "create", message: err.message, stack: err.stack });
    throw err;
  }
}
