// Direct Google OAuth 2.0 + Gmail/Calendar REST access (no CLI needed).
// The user registers an OAuth client in Google Cloud Console and puts
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env. Tokens live in the
// settings table and are stripped from public settings (see SECRET_SETTINGS).

import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "./db";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
export const GOOGLE_API_BASE = process.env.GOOGLE_API_BASE || "https://www.googleapis.com";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID || "";
}

function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET || "";
}

export function googleRedirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI || "http://127.0.0.1:3002/api/oauth/google/callback";
}

export function googleConfigured(): boolean {
  return !!(googleClientId() && googleClientSecret());
}

/** Consent URL for the Connect button; null when OAuth isn't configured. */
export function googleAuthUrl(): string | null {
  if (!googleConfigured()) return null;
  const q = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // consent every time so Google always returns a refresh token
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

export function googleClear(db: Database): void {
  for (const k of ["google_access_token", "google_refresh_token", "google_token_expiry"]) {
    setSetting(db, k, "");
  }
}

async function tokenRequest(params: Record<string, string>): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: googleClientId(), client_secret: googleClientSecret(), ...params }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function storeTokens(db: Database, j: any): boolean {
  if (!j || !j.access_token) return false;
  const now = Date.now();
  setSetting(db, "google_access_token", String(j.access_token));
  setSetting(db, "google_token_expiry", String(now + (Number(j.expires_in) || 3600) * 1000));
  if (j.refresh_token) setSetting(db, "google_refresh_token", String(j.refresh_token));
  return true;
}

/** Exchange the callback code for tokens; stores them in settings. */
export async function googleExchangeCode(db: Database, code: string): Promise<boolean> {
  if (!googleConfigured()) return false;
  const j = await tokenRequest({
    code,
    redirect_uri: googleRedirectUri(),
    grant_type: "authorization_code",
  });
  return storeTokens(db, j);
}

/** A usable access token, refreshing silently when needed. Null = (re)connect. */
export async function googleAccessToken(db: Database): Promise<string | null> {
  const now = Date.now();
  const tok = getSetting(db, "google_access_token");
  const exp = Number(getSetting(db, "google_token_expiry") || 0);
  if (tok && exp - now > 60000) return tok;
  const refresh = getSetting(db, "google_refresh_token");
  if (!refresh || !googleConfigured()) return null;
  const j = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
  if (!storeTokens(db, j)) {
    googleClear(db); // refresh token rejected — user must reconnect
    return null;
  }
  return getSetting(db, "google_access_token") || null;
}

/**
 * Authenticated GET against the Google API. Returns the parsed JSON, or
 * { __disconnected: true } when the user needs to (re)connect.
 */
export async function googleGet(
  db: Database,
  path: string,
  params: Record<string, string> = {}
): Promise<any> {
  const tok = await googleAccessToken(db);
  if (!tok) return { __disconnected: true };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${GOOGLE_API_BASE}${path}${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${tok}` },
      signal: ctrl.signal,
    });
    if (res.status === 401) {
      googleClear(db);
      return { __disconnected: true };
    }
    if (!res.ok) throw new Error(`Google API ${res.status}`);
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(t);
  }
}
