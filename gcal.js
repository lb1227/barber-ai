// gcal.js
import { google } from "googleapis";
import fs from "fs";
import path from "path";


const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI, 
  GOOGLE_CALENDAR_ID,  // preferred env var
  CALENDAR_ID: LEGACY_CALENDAR_ID, // fallback name
} = process.env;

// Use GOOGLE_CALENDAR_ID if present, else CALENDAR_ID, else "primary"
const CALENDAR_ID = GOOGLE_CALENDAR_ID || LEGACY_CALENDAR_ID || "primary";

const TOKEN_DIR = process.env.GOOGLE_TOKEN_DIR || "/data";
if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
const TOKEN_PATH = path.join(TOKEN_DIR, "google_tokens.json");

const AUDIT_PATH = path.join(TOKEN_DIR, "audit.log");

const TOK_B64 = process.env.GOOGLE_TOKENS_JSON_B64;
if (TOK_B64 && !fs.existsSync(TOKEN_PATH)) {
  try {
    const buf = Buffer.from(TOK_B64, "base64").toString("utf8");
    JSON.parse(buf); // validate
    fs.writeFileSync(TOKEN_PATH, buf, "utf8");
    console.log("[GCAL] Seeded tokens from env to", TOKEN_PATH);
  } catch (e) {
    console.warn("[GCAL] Failed to seed tokens from GOOGLE_TOKENS_JSON_B64:", e.message);
  }
}

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

  // Load tokens (if present)
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
      if (tokens && (tokens.refresh_token || tokens.access_token)) {
        oauth2.setCredentials(tokens);
        console.log("[GCAL] Loaded tokens from", TOKEN_PATH, {
          has_refresh: !!tokens.refresh_token
        });
      }
    } catch (e) {
      console.warn("[GCAL] Failed to parse tokens file", e.message);
    }
  }

  // Persist new/updated tokens
  oauth2.on("tokens", (t) => {
    let current = {};
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        current = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
      }
    } catch (e) {
      console.warn("[GCAL] Could not read existing token file:", e.message);
    }
    const merged = { ...current, ...t };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), "utf8");
    console.log("[GCAL] Tokens updated. has_refresh:", !!merged.refresh_token);
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
  fs.appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n", () => {});
}

export async function listEventsOn(dateIso) {
  const cal = calendarClient();
  const d = new Date(dateIso);
  const start = new Date(d); start.setHours(0, 0, 0, 0);
  const end   = new Date(d); end.setHours(23, 59, 59, 999);

  const { data } = await cal.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return data.items || [];
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
