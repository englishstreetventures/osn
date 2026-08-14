/**
 * HttpOnly cookie management for session tokens (Copenhagen Book C3).
 *
 * The `__Host-` prefix enforces: Secure, exact-domain, Path=/. In local dev
 * (no TLS), we drop the prefix and Secure flag — browsers reject `__Host-`
 * cookies without Secure.
 */

export interface CookieSessionConfig {
  /** Whether to set Secure flag + use __Host- prefix (true in non-local envs) */
  secure: boolean;
  /**
   * Domain for the JS-readable session MARKER cookie only (never the session
   * cookie, which stays `__Host-` host-only). The issuer and the apps that
   * call it sit on different hosts of one site — `id.musubi.social` vs
   * `musubi.social` — so a host-only marker would be invisible to the app.
   * Leave unset in local dev (same host, different port ⇒ host-only works).
   */
  markerDomain?: string;
}

const COOKIE_NAME_SECURE = "__Host-osn_session";
const COOKIE_NAME_LOCAL = "osn_session";

/**
 * Name of the non-HttpOnly marker cookie. Carries no secret — just the bit
 * "this browser holds a session cookie" — so the client can skip the
 * cold-start `POST /token` when there is plainly nothing to redeem.
 */
export const SESSION_MARKER_COOKIE_NAME = "osn_has_session";

const MAX_AGE_SECONDS = 2592000;

export function cookieName(config: CookieSessionConfig): string {
  return config.secure ? COOKIE_NAME_SECURE : COOKIE_NAME_LOCAL;
}

/** Both cookie names for redaction purposes. */
export const SESSION_COOKIE_NAMES = [COOKIE_NAME_SECURE, COOKIE_NAME_LOCAL] as const;

/**
 * Builds the Set-Cookie header value for a session token.
 * Max-Age = 30 days (2592000s), matching the server-side session TTL.
 */
export function buildSessionCookie(token: string, config: CookieSessionConfig): string {
  const name = cookieName(config);
  const parts = [
    `${name}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (config.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Builds a Set-Cookie header that clears the session cookie.
 */
export function buildClearSessionCookie(config: CookieSessionConfig): string {
  const name = cookieName(config);
  const parts = [`${name}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (config.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * A bare hostname, nothing else. The domain reaches this file from
 * `wrangler.toml` via `Env`, so it is trusted today — but it is interpolated
 * straight into a response header, and a value carrying `;` or CR/LF would
 * splice extra attributes onto the cookie. Validating at the one point that
 * emits it keeps that closed if the value ever comes from somewhere less
 * trusted (S-L2).
 */
const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/i;

function markerCookieParts(config: CookieSessionConfig): string[] {
  const parts = ["SameSite=Lax", "Path=/"];
  // Fail closed to a host-only marker rather than emitting a malformed header.
  // Host-only costs a cold-start sign-in on a split-host deployment; a spliced
  // header is a defect.
  if (config.markerDomain && HOSTNAME_PATTERN.test(config.markerDomain)) {
    parts.push(`Domain=${config.markerDomain}`);
  }
  if (config.secure) {
    parts.push("Secure");
  }
  return parts;
}

/** Builds the Set-Cookie header for the JS-readable marker. Not HttpOnly, by design. */
export function buildSessionMarkerCookie(config: CookieSessionConfig): string {
  return [
    `${SESSION_MARKER_COOKIE_NAME}=1`,
    ...markerCookieParts(config),
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join("; ");
}

/** Builds the Set-Cookie header that clears the marker. Attributes must match the setter. */
export function buildClearSessionMarkerCookie(config: CookieSessionConfig): string {
  return [`${SESSION_MARKER_COOKIE_NAME}=`, ...markerCookieParts(config), "Max-Age=0"].join("; ");
}

/**
 * Session cookie + marker, for the `set-cookie` response header.
 *
 * Every route that establishes a session must set BOTH, so the marker never
 * disagrees with the cookie it describes.
 */
export function buildSessionCookies(token: string, config: CookieSessionConfig): string[] {
  return [buildSessionCookie(token, config), buildSessionMarkerCookie(config)];
}

/** Clears both the session cookie and its marker. */
export function buildClearSessionCookies(config: CookieSessionConfig): string[] {
  return [buildClearSessionCookie(config), buildClearSessionMarkerCookie(config)];
}

/**
 * Reads the session token from the Cookie header. Returns null if not found.
 */
export function readSessionCookie(
  cookieHeader: string | undefined,
  config: CookieSessionConfig,
): string | null {
  if (!cookieHeader) return null;
  const name = cookieName(config);
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      return value || null;
    }
  }
  return null;
}
