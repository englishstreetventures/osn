/**
 * Session cookie helpers. Host-scoped (no `Domain=`) so the cookie sticks to
 * whichever origin issues it — fine for same-origin dev and the eventual
 * apex-only production deployment. When a wildcard subdomain layout lands we'll
 * need to revisit and add `Domain=`.
 */

const COOKIE_NAME = "cire_session";

export interface SessionCookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * Programmer-error guard: tokens come from `generateSessionToken` which only
 * emits `[A-Za-z0-9_-]`. A malformed value here means a caller (or future bug)
 * is feeding raw input straight into a Set-Cookie header — throw fast so it
 * shows up in tests rather than producing a corrupted cookie at runtime.
 * `lib/` helpers are allowed to throw on programmer error; services aren't.
 */
export function buildSessionCookie(token: string, opts: SessionCookieOptions): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new TypeError("session token contains invalid chars");
  }
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  // `Cookie:` is `name=value; name2=value2`. Each pair is separated by `; `.
  const pairs = cookieHeader.split(";");
  for (const raw of pairs) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
