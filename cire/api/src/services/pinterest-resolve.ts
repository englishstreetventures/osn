/**
 * Pinterest `pin.it` short-link resolution, run server-side at CSV import time.
 *
 * Why this exists: the guest embed (`cire/web`) can only render Pinterest's
 * board widget from a full `https://www.pinterest.com/<user>/<board>/` URL —
 * `pinit_main.js` cannot embed a `pin.it` short link. Real organiser data is
 * almost always pasted as a `pin.it/...` short link, so without resolution the
 * board never embeds and guests only get the fallback link-out. We resolve the
 * short link ONCE, here at import time, and persist the canonical board URL.
 *
 * This module is deliberately split into two halves:
 *
 *   1. `canonicalizePinterestBoardUrl` — PURE, unit-testable. Given a resolved
 *      location string, returns the canonical `https://www.pinterest.com/<user>/
 *      <board>/` board URL (all query/tracking stripped) or `null` when the
 *      input is not a recognisable pinterest *board*.
 *   2. `resolvePinUrl` — the network half. Only ever fetches `pin.it` /
 *      `www.pin.it` inputs (SSRF allowlist), follows redirects with a capped
 *      depth + short timeout, and feeds the final location to the pure helper.
 *      Any failure falls back to the ORIGINAL url unchanged — resolution must
 *      never block or throw out of the import.
 */

// Pinterest web hosts whose `/user/board` URLs the guest board widget can embed.
// `www.` prefix is normalised away when we re-emit, so both forms are accepted.
const PINTEREST_BOARD_HOSTS = new Set<string>([
  "pinterest.com",
  "pinterest.com.au",
  "pinterest.co.uk",
  "pinterest.ca",
  "pinterest.de",
  "pinterest.fr",
  "pinterest.es",
  "pinterest.it",
  "pinterest.nz",
  "pinterest.ie",
]);

// The two short-link hosts we are willing to make an outbound fetch to. This is
// the SSRF allowlist — we NEVER fetch an arbitrary user-supplied URL, only a
// first-party Pinterest short link.
const PIN_IT_HOSTS = new Set<string>(["pin.it", "www.pin.it"]);

// A board path is `/<user>/<board>` with an optional single section sub-segment
// (`/<user>/<board>/<section>`). Segments use the URL-safe characters real
// Pinterest slugs use; whitespace and `%20` are rejected so a junk slug can't
// masquerade as a board.
const BOARD_SEGMENT = "(?:(?!%20)[A-Za-z0-9._~%-])+";
const BOARD_PATH_PATTERN = new RegExp(
  `^/(${BOARD_SEGMENT})/(${BOARD_SEGMENT})(?:/${BOARD_SEGMENT})?/?$`,
);

/** Strip a leading `www.` so `www.pinterest.com` and `pinterest.com` collapse. */
function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Is `host` (case-insensitive, `www.`-insensitive) a host we'll fetch a short
 * link from? Exact-match against the allowlist — `pin.it.evil.com` and
 * `evilpin.it` do NOT match.
 */
export function isPinItHost(host: string): boolean {
  return PIN_IT_HOSTS.has(host.toLowerCase());
}

/**
 * Pure canonicalisation: given a resolved location string, return the canonical
 * embeddable board URL or `null`.
 *
 * Rules:
 *  - https only; foreign hosts rejected; host must be a pinterest board host.
 *  - A `pin.it` short link as the FINAL location is rejected (it never resolved
 *    to a real board — null, keep original).
 *  - `/pin/<id>` is a single pin, NOT a board → null (keep original; the embed
 *    widget needs a board, and the link-out still works).
 *  - `/<user>` profile-only → null.
 *  - `/<user>/<board>` (optionally `/<user>/<board>/<section>`) → canonical
 *    `https://www.pinterest.com/<user>/<board>/` (host normalised to `www.`,
 *    ALL query params + fragment stripped, trailing slash added).
 */
export function canonicalizePinterestBoardUrl(location: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const host = stripWww(parsed.hostname.toLowerCase());
  if (!PINTEREST_BOARD_HOSTS.has(host)) return null;

  // `/pin/<id>` is a single pin, not a board — explicitly not embeddable.
  if (/^\/pin\//i.test(parsed.pathname)) return null;

  const match = BOARD_PATH_PATTERN.exec(parsed.pathname);
  if (!match) return null;

  // Re-emit canonically: normalise host to the `www.` form Pinterest's widget
  // expects, keep the original path (sans trailing slash), drop ALL query +
  // fragment (tracking params), and add a single trailing slash.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `https://www.${host}${path}/`;
}

/** Options for {@link resolvePinUrl}; defaults match the import call-site. */
export interface ResolvePinUrlOptions {
  /** Max number of redirects to follow before giving up. */
  readonly maxRedirects?: number;
  /** Per-attempt timeout in ms (AbortController). */
  readonly timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Resolve a (possibly `pin.it`) pinterest URL to its canonical board URL.
 *
 * Contract (never throws, never blocks the import):
 *  - Input host NOT `pin.it`/`www.pin.it` → returned unchanged (we only fetch
 *    the short-link allowlist; everything else is the parser's problem). This
 *    also means an already-canonical `pinterest.com/<user>/<board>` URL passes
 *    straight through without a network call.
 *  - `pin.it` input → manual redirect loop (capped depth + timeout). The final
 *    location is canonicalised; if it's a real board we return the canonical
 *    URL, otherwise (non-pinterest host, single pin, profile, still a pin.it,
 *    any fetch error/timeout) we return the ORIGINAL url unchanged.
 */
export async function resolvePinUrl(
  url: string,
  options: ResolvePinUrlOptions = {},
): Promise<string> {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url; // unparseable — leave it for the rest of the pipeline.
  }

  // SSRF allowlist: only ever fetch a first-party Pinterest short link.
  if (!isPinItHost(host)) return url;

  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        // Redirect hops are inherently sequential — each follows the previous
        // hop's Location header, so they can't be parallelised.
        // eslint-disable-next-line no-await-in-loop
        response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "cire-import/1.0" },
        });
      } finally {
        clearTimeout(timer);
      }

      const status = response.status;
      // 3xx with a Location → follow it (resolved against the current URL).
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          break;
        }
        current = next;
        // A short link should resolve OFF the pin.it host quickly; once we've
        // landed on a pinterest board host, canonicalise and we're done.
        const canonical = canonicalizePinterestBoardUrl(current);
        if (canonical) return canonical;
        continue;
      }

      // Non-redirect terminal response: canonicalise whatever URL we ended on.
      const canonical = canonicalizePinterestBoardUrl(current);
      return canonical ?? url;
    }
  } catch {
    // Any network error / abort / timeout → fall back to the original url.
    return url;
  }

  // Ran out of redirects without landing on a board → keep original.
  return url;
}
