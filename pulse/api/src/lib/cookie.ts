import { buildClearCookie, buildCookie, parseCookie } from "@shared/osn-auth-client/cookie";
import type { SessionCookieOptions } from "@shared/osn-auth-client/cookie";

/**
 * Pulse's cookie names, over the shared codec in `@shared/osn-auth-client/cookie`
 * — which is where the host-scoping and `SameSite=Lax` reasoning lives. Names
 * are fixed here so no caller passes one as a string.
 *
 * Two cookies, both minted by the OSN OIDC redirect flow:
 *
 * - `pulse_web_session` — the browser session for the Pulse web app.
 * - `pulse_oidc_tx`     — the short-lived transaction state (PKCE verifier,
 *                         `state`, `nonce`, return URL) held between
 *                         `/api/auth/oidc/start` and `/api/auth/oidc/callback`.
 *
 * The iOS app has no cookie: it holds an OSN refresh token and presents a
 * bearer access JWT. These two exist only because a browser cannot run a
 * passkey ceremony against `musubi.social` from a Pulse origin.
 *
 * Both are host-scoped — set by pulse-api and sent back only there. That makes
 * the Pulse API host and the Pulse web origin same-site by requirement, not by
 * preference: `api.<pulse-domain>` and `<pulse-domain>` share a registrable
 * domain, so `Lax` lets the cookie ride along. A Pulse web origin on an
 * unrelated domain would never receive it. Do NOT add `Domain=`.
 */

const SESSION_COOKIE_NAME = "pulse_web_session";
const OIDC_TX_COOKIE_NAME = "pulse_oidc_tx";

export type { SessionCookieOptions };

export function buildWebSessionCookie(token: string, opts: SessionCookieOptions): string {
  return buildCookie(SESSION_COOKIE_NAME, token, opts);
}

export function clearWebSessionCookie(opts: { secure: boolean }): string {
  return buildClearCookie(SESSION_COOKIE_NAME, opts);
}

export function parseWebSessionToken(cookieHeader: string | null): string | null {
  return parseCookie(cookieHeader, SESSION_COOKIE_NAME);
}

/** True when the request carries a Pulse session cookie at all — the CSRF signal the origin guard keys on. */
export function hasWebSessionCookie(cookieHeader: string | null): boolean {
  return parseWebSessionToken(cookieHeader) !== null;
}

/**
 * The transaction value is `<base64url JSON>.<base64url HMAC>` — HMAC-signed by
 * `@shared/osn-auth-client/oidc-rp` so a planted or tampered cookie is rejected
 * (session-fixation guard). Both halves are base64url and the single dot is
 * cookie-safe.
 */
export function buildOidcTxCookie(value: string, opts: SessionCookieOptions): string {
  return buildCookie(OIDC_TX_COOKIE_NAME, value, opts);
}

export function clearOidcTxCookie(opts: { secure: boolean }): string {
  return buildClearCookie(OIDC_TX_COOKIE_NAME, opts);
}

export function parseOidcTxCookie(cookieHeader: string | null): string | null {
  return parseCookie(cookieHeader, OIDC_TX_COOKIE_NAME);
}
