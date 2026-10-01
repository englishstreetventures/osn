/**
 * Check a `WEB_ORIGIN` value before the Worker trusts it.
 *
 * The one list feeds the CORS origin match, the CSRF origin guard, the session
 * cookie's `Secure` flag and the organiser links in emails, so a bad entry
 * widens all four at once. Every entry must be an exact origin, the form a
 * browser sends in `Origin`: parsing it and comparing `URL.origin` back to the
 * text refuses a path, a trailing slash, userinfo, upper case and an explicit
 * default port, any of which would either never match or match more than meant.
 *
 * `https:` is always accepted. `http:` is accepted only for the host
 * `localhost` exactly, and only when `isDeployed()` says this is not a deployed
 * tier; `isDeployed` is called only when such an entry is present, so the
 * common all-`https` list never pays for the tier lookup.
 *
 * Returns null when every entry passes, otherwise the reason for the first
 * failing one. The reason names the entry by position, never by its text: it
 * ends up in a public 503 body, and an entry with userinfo would put a
 * credential there.
 */
export function webOriginProblem(raw: string, isDeployed: () => boolean): string | null {
  const entries = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (entries.length === 0) return "WEB_ORIGIN has no entries";

  for (const [index, entry] of entries.entries()) {
    const position = `WEB_ORIGIN entry ${index + 1}`;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return `${position} is not a URL`;
    }
    if (url.origin !== entry) {
      return `${position} must be a bare origin (scheme, lower-case host, optional port; no path, trailing slash or userinfo)`;
    }
    if (url.protocol === "https:") continue;
    if (url.protocol === "http:" && url.hostname === "localhost" && !isDeployed()) continue;
    return `${position} must be https:// (http://localhost only outside a deployed tier)`;
  }
  return null;
}
