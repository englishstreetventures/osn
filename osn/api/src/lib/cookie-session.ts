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
}

const COOKIE_NAME_SECURE = "__Host-osn_session";
const COOKIE_NAME_LOCAL = "osn_session";

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
  const parts = [`${name}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"];
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
