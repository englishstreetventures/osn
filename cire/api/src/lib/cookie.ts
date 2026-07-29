/**
 * Cookie helpers. **Every cookie here is host-scoped by design (no `Domain=`).**
 * They are set by cire-api (`api.cireweddings.com`) and sent back ONLY to
 * cire-api — same-origin to the API and HttpOnly (no browser code reads them).
 * Host-scoping is the correct, tighter choice: a broad `Domain=.cireweddings.com`
 * would needlessly widen them to every subdomain (the Pages hosts, future ones)
 * with no consumer that needs it. Audited `feat/cire-assets-reconcile` — keep
 * host-scoped; do NOT add `Domain=` unless a subdomain genuinely needs to read
 * one (none does today). See `cire/wiki/todo/api.md`.
 *
 * Three cookies live here:
 *
 * - `cire_session`  — the guest household session, minted by `POST /api/claim`.
 * - `cire_org_session` — the organiser session, minted by the OSN OIDC callback.
 * - `cire_oidc_tx`  — the short-lived OIDC transaction state (PKCE verifier,
 *                     `state`, `nonce`, return URL) held between `/start` and
 *                     `/callback`.
 *
 * `SameSite=Lax` on all three. It is not merely tolerable but required for the
 * OIDC pair: the callback arrives as a top-level GET navigation from
 * `id.musubi.social`, which `Lax` allows and `Strict` would drop — the browser
 * would land on the callback with no transaction cookie and every sign-in would
 * fail. `Lax` still withholds all three from cross-site subrequests, which is
 * the protection that matters, and the organiser and guest sites reaching
 * `api.cireweddings.com` are same-site anyway.
 */

const GUEST_COOKIE_NAME = "cire_session";
const ORGANISER_COOKIE_NAME = "cire_org_session";
const OIDC_TX_COOKIE_NAME = "cire_oidc_tx";

export interface SessionCookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * Programmer-error guard: values come from `generateToken` (which only emits
 * `[A-Za-z0-9_-]`) or from a base64url-encoded payload. A malformed value here
 * means a caller (or future bug) is feeding raw input straight into a
 * Set-Cookie header — throw fast so it shows up in tests rather than producing
 * a corrupted cookie at runtime. `lib/` helpers are allowed to throw on
 * programmer error; services aren't.
 */
function buildCookie(name: string, value: string, opts: SessionCookieOptions): string {
  // `.` is permitted (and cookie-safe per RFC 6265 cookie-octet): the OIDC
  // transaction cookie is `<b64url payload>.<b64url HMAC>`, so its value carries
  // one dot separating the payload from its integrity tag. Opaque session tokens
  // (guest + organiser) never contain a dot; the guard still rejects the unsafe
  // set (`; , " \` and whitespace) that would corrupt a Set-Cookie header.
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new TypeError(`${name} value contains invalid chars`);
  }
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function buildClearCookie(name: string, opts: { secure: boolean }): string {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  // `Cookie:` is `name=value; name2=value2`. Each pair is separated by `; `.
  const pairs = cookieHeader.split(";");
  for (const raw of pairs) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const cookieName = pair.slice(0, eq).trim();
    if (cookieName !== name) continue;
    const value = pair.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

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
 * `oidc-login.ts` so a planted/tampered cookie is rejected (session-fixation
 * guard). Both halves are base64url and the single dot is cookie-safe.
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
