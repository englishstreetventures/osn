/**
 * Set-Cookie / Cookie codec for a relying party's OWN session cookies — the
 * server-side counterpart to `@shared/rp-auth`, which reads none of them
 * (they are all `HttpOnly`).
 *
 * **Every cookie built here is host-scoped by design (no `Domain=`).** It is
 * set by the app's API host and sent back ONLY to that host. Host-scoping is
 * the tighter choice: a broad `Domain=.example.com` would widen the cookie to
 * every subdomain with no consumer that needs it. Do NOT add `Domain=` unless
 * a subdomain genuinely has to read one.
 *
 * `SameSite=Lax` on all of them. It is not merely tolerable but required for
 * an OIDC pair: the callback arrives as a top-level GET navigation from the
 * issuer, which `Lax` allows and `Strict` would drop — the browser would land
 * on the callback with no transaction cookie and every sign-in would fail.
 * `Lax` still withholds the cookie from cross-site subrequests, which is the
 * protection that matters. It does mean the API host must be **same-site with
 * the app's own origin**: `api.example.com` and `app.example.com` share the
 * registrable domain, so the cookie rides along; a cookie set on an unrelated
 * host never will.
 *
 * Callers wrap these in named helpers (`buildSessionCookie`, …) so a cookie
 * NAME is fixed in one place per product rather than passed around as a string.
 */

export interface SessionCookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * Programmer-error guard: values come from `generateToken` (which only emits
 * `[A-Za-z0-9_-]`) or from a base64url-encoded payload. A malformed value here
 * means a caller (or future bug) is feeding raw input straight into a
 * Set-Cookie header — throw fast so it shows up in tests rather than producing
 * a corrupted cookie at runtime.
 *
 * `.` is permitted (and cookie-safe per RFC 6265 cookie-octet): an OIDC
 * transaction cookie is `<b64url payload>.<b64url HMAC>`, so its value carries
 * one dot separating the payload from its integrity tag. Opaque session tokens
 * never contain a dot; the guard still rejects the unsafe set (`; , " \` and
 * whitespace) that would corrupt a Set-Cookie header.
 */
export function buildCookie(name: string, value: string, opts: SessionCookieOptions): string {
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

/**
 * The expiring twin of `buildCookie`. `Path` and `Secure` must match the
 * original or the browser keeps the cookie and clears nothing.
 */
export function buildClearCookie(name: string, opts: { secure: boolean }): string {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** One named cookie out of a raw `Cookie:` header, or `null`. */
export function parseCookie(cookieHeader: string | null, name: string): string | null {
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
