/**
 * Browser-binding cookie for parked OIDC authorization requests (S-M1 oidc).
 *
 * When `/authorize` parks a request and redirects to the consent UI, the
 * response also sets a short-TTL HttpOnly cookie carrying a per-request
 * secret; the parked request stores only the secret's SHA-256. The decision
 * (and context read) must arrive with the matching cookie, so a request id
 * that leaks — a forwarded link, a referrer log, a lucky guess — cannot be
 * approved from any browser except the one that started the flow.
 *
 * One cookie PER REQUEST (the name embeds the request id) so two authorize
 * flows racing in one browser cannot clobber each other's binding. The
 * `__Host-` prefix rules match `cookie-session.ts`: Secure + Path=/ + no
 * Domain in non-local envs, prefix dropped locally where there is no TLS.
 */

import type { CookieSessionConfig } from "./cookie-session";

/** Lifetime matches AUTHORIZE_REQUEST_TTL_MS — the cookie outlives nothing. */
const BINDING_COOKIE_MAX_AGE_SEC = 600;

function bindingCookieName(requestId: string, config: CookieSessionConfig): string {
  return config.secure ? `__Host-osn_${requestId}` : `osn_${requestId}`;
}

/** Builds the Set-Cookie value binding `requestId` to this browser. */
export function buildBindingCookie(
  requestId: string,
  secret: string,
  config: CookieSessionConfig,
): string {
  const parts = [
    `${bindingCookieName(requestId, config)}=${secret}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${BINDING_COOKIE_MAX_AGE_SEC}`,
  ];
  if (config.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Builds the Set-Cookie value that clears a consumed binding. */
export function buildClearBindingCookie(requestId: string, config: CookieSessionConfig): string {
  const parts = [
    `${bindingCookieName(requestId, config)}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (config.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Reads the binding secret for `requestId` out of the Cookie header. */
export function readBindingCookie(
  cookieHeader: string | undefined,
  requestId: string,
  config: CookieSessionConfig,
): string | null {
  if (!cookieHeader) return null;
  const prefix = `${bindingCookieName(requestId, config)}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      return value || null;
    }
  }
  return null;
}
