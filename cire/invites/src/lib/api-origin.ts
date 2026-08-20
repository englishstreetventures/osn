/**
 * The cire-api ORIGIN, for `<link rel="preconnect">`.
 *
 * Why this exists: the guest site (`invite.cireweddings.com`) and cire-api
 * (`api.cireweddings.com`) are separate origins, so the browser must pay DNS +
 * TCP + TLS before its FIRST request to the API — and that first request is on
 * the critical path the moment a guest submits their code (`POST /api/claim`)
 * or the page restores an existing session (`GET /api/claim/session`).
 *
 * The SSR fetch in `[slug].astro` does not help here: that subrequest is made by
 * the guest-site Worker, not by the browser, so it warms the API isolate but
 * leaves the browser's own connection cold. The hero-image preload opens one as
 * a side effect, but only for weddings that HAVE a hero image, and only once the
 * `<link>` at the end of `<head>` is reached.
 *
 * `preconnect` is transport only — it warms no data. Nothing per-household can
 * be pre-warmed anyway, since the claim query is keyed on a code the page does
 * not have.
 *
 * Deliberately emitted WITHOUT `crossorigin`: browsers keep separate socket
 * pools for credentialed and anonymous connections, and every request the guest
 * site makes to the API is credentialed — `fetch(..., { credentials: "include" })`
 * for claim/restore/RSVP, and plain `<img>` loads for the hero and event images.
 * An anonymous preconnect (the shape an anonymous-CORS asset fetch would need)
 * would warm the wrong pool and buy nothing here.
 */
export function apiPreconnectHref(apiUrl: string): string | null {
  try {
    const { origin, protocol } = new URL(apiUrl);
    // `origin` is the literal string "null" for opaque origins (e.g. a `data:`
    // URL), which is not a preconnectable host.
    if (origin === "null") return null;
    // Only http(s) is preconnectable; anything else is a misconfigured env var.
    if (protocol !== "http:" && protocol !== "https:") return null;
    return origin;
  } catch {
    // A malformed PUBLIC_API_URL must not take the invite down — skip the hint.
    return null;
  }
}
