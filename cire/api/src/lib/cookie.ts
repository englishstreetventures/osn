import { buildClearCookie, buildCookie, parseCookie } from "@shared/osn-auth-client/cookie";
import type { SessionCookieOptions } from "@shared/osn-auth-client/cookie";

/**
 * Cire's cookie names, over the shared codec in `@shared/osn-auth-client/cookie`
 * — which is where the host-scoping and `SameSite=Lax` reasoning lives. Names
 * are fixed here so no caller passes one as a string.
 *
 * Three cookies:
 *
 * - `cire_session`  — the guest household session, minted by `POST /api/claim`.
 * - `cire_org_session` — the organiser session, minted by the OSN OIDC callback.
 * - `cire_oidc_tx`  — the short-lived OIDC transaction state (PKCE verifier,
 *                     `state`, `nonce`, return URL) held between `/start` and
 *                     `/callback`.
 *
 * All three are host-scoped: set by cire-api (`api.cireweddings.com`) and sent
 * back only there. The organiser and guest sites are same-site with it, so
 * `Lax` costs nothing. Audited `feat/cire-assets-reconcile` — do NOT add
 * `Domain=` unless a subdomain genuinely needs to read one (none does today).
 * Tracked as an open issue in `xchromo/osn` (`label:product:cire`).
 */

const GUEST_COOKIE_NAME = "cire_session";
const ORGANISER_COOKIE_NAME = "cire_org_session";
const OIDC_TX_COOKIE_NAME = "cire_oidc_tx";

export type { SessionCookieOptions };

export function buildSessionCookie(token: string, opts: SessionCookieOptions): string {
  return buildCookie(GUEST_COOKIE_NAME, token, opts);
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  return buildClearCookie(GUEST_COOKIE_NAME, opts);
}

export function parseSessionToken(cookieHeader: string | null): string | null {
  return parseCookie(cookieHeader, GUEST_COOKIE_NAME);
}

export function buildOrganiserSessionCookie(token: string, opts: SessionCookieOptions): string {
  return buildCookie(ORGANISER_COOKIE_NAME, token, opts);
}

export function clearOrganiserSessionCookie(opts: { secure: boolean }): string {
  return buildClearCookie(ORGANISER_COOKIE_NAME, opts);
}

export function parseOrganiserSessionToken(cookieHeader: string | null): string | null {
  return parseCookie(cookieHeader, ORGANISER_COOKIE_NAME);
}

/**
 * The transaction value is `<base64url JSON>.<base64url HMAC>` — HMAC-signed by
 * `@shared/osn-auth-client/oidc-rp` so a planted/tampered cookie is rejected
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
