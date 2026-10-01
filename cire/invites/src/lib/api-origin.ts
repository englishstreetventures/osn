/** The cire-api origin `public/_headers` is written for. */
export const PRODUCTION_API_ORIGIN = "https://api.cireweddings.com";

/** The local cire-api: `bun run dev` in `cire/api` (src/local.ts, port 8787). */
export const LOCAL_API_URL = "http://localhost:8787";

/**
 * Which cire-api the guest site talks to, given `PUBLIC_API_URL`.
 *
 * Called twice: by `lib/invite.ts` with `import.meta.env` for the pages and
 * islands, and by `lib/tier-headers.ts` with Vite's resolved env for the CSP in
 * `dist/client/_headers`. Both reading the same chain is what keeps the policy
 * naming the API the site calls, so this module reads no env and imports
 * nothing — the build loads it outside Vite's `import.meta.env` handling.
 * `??` on purpose: an empty value stays empty, and the header rewrite then
 * fails the build instead of quietly picking the local API.
 */
export function resolveApiUrl(env: string | undefined): string {
  return env ?? LOCAL_API_URL;
}

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
 * for claim/restore/RSVP and the islands' invite retry, and plain `<img>` loads
 * for the hero and event images. An anonymous preconnect (the shape an
 * anonymous-CORS asset fetch would need) would warm the wrong pool and buy
 * nothing here.
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
