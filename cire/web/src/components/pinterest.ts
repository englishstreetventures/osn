/**
 * Pinterest URL validators.
 *
 * `pinterestUrl` arrives as server-supplied free text from the claim response.
 * Before it lands in `<a href=...>` or as input to Pinterest's embed script, it
 * must clear one of two gates depending on how it's used. We deliberately split
 * "is this a safe URL to link to" from "is this embeddable as a board widget",
 * because the embed widget needs a stricter shape than a plain outbound link —
 * and a guest must ALWAYS be able to reach the moodboard via a link even when
 * the URL is a shape the widget can't embed (a `pin.it` short link, a board
 * with a section sub-path, a profile-level link, etc.).
 *
 *   - `isSafePinterestLinkUrl`  → gates the always-visible fallback `<a href>`.
 *     Loose on path shape, strict on host + scheme: only https, only Pinterest
 *     hosts (incl. the `pin.it` short-link host). Rejects `javascript:`,
 *     foreign hosts, and host-injection lookalikes.
 *   - `isEmbeddablePinterestBoardUrl` → gates the embed script + `<a data-pin-do>`
 *     anchor. The strict `/user/board` board-widget shape Pinterest's
 *     `pinit_main.js` can actually render.
 *
 * Defence in depth: both validators re-parse the URL via the `URL` constructor
 * with an explicit host allowlist, so a future regex regression can't slip a
 * foreign host through.
 */

// Pinterest's canonical web hosts plus their regional TLDs, each with an
// optional `www.` prefix. `pin.it` is Pinterest's first-party short-link host —
// pasted boards are very often shortened to it, so it must be a safe link
// target even though it is never directly embeddable.
const PINTEREST_HOSTS = [
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
] as const;

// Hosts we will put in an outbound `<a href>`. Includes the `pin.it` short-link
// host and every Pinterest host with an optional `www.` prefix.
const SAFE_LINK_HOSTS = new Set<string>([
  "pin.it",
  ...PINTEREST_HOSTS,
  ...PINTEREST_HOSTS.map((h) => `www.${h}`),
]);

// Hosts the board-embed widget supports. `pin.it` is excluded — the widget
// needs the resolved `/user/board` URL, not a short link.
const EMBEDDABLE_BOARD_HOSTS = new Set<string>([
  ...PINTEREST_HOSTS,
  ...PINTEREST_HOSTS.map((h) => `www.${h}`),
]);

// Path segments allow letters, digits, and the URL-safe symbols Pinterest
// actually uses on board URLs. Permits `-`, `.`, `_`, `~`, `%` (percent-encoded
// chars) but rejects whitespace and other shell-y characters. `?` / `#` never
// reach the pattern — they're handled by the explicit search/hash check below.
//
// Embeddable boards are `/<user>/<board>` with an optional trailing slash and an
// optional single section sub-segment (`/<user>/<board>/<section>`). The host is
// checked separately via the URL parse below, so the host portion here is
// intentionally permissive. `%20` (an encoded space) is excluded — real board
// slugs never contain whitespace, and the embed widget wants a clean slug.
const PATH_SEGMENT_NO_SPACE = "(?:(?!%20)[A-Za-z0-9._~%-])+";
const BOARD_PATH_PATTERN = new RegExp(
  `^/${PATH_SEGMENT_NO_SPACE}/${PATH_SEGMENT_NO_SPACE}(/${PATH_SEGMENT_NO_SPACE})?/?$`,
);

function parseHttpsUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? parsed : null;
}

/**
 * Is `url` a safe https Pinterest URL to put in an outbound `<a href>`?
 *
 * Loose on path shape (any board / pin / profile / `pin.it` short link),
 * strict on scheme + host. This gate keeps the moodboard reachable even when
 * the URL can't be embedded as a board widget.
 */
export function isSafePinterestLinkUrl(url: string): boolean {
  const parsed = parseHttpsUrl(url);
  if (!parsed) return false;
  return SAFE_LINK_HOSTS.has(parsed.hostname);
}

/**
 * Is `url` an embeddable Pinterest *board* URL that `pinit_main.js` can render?
 *
 * Strict `/user/board` (optionally `/user/board/section`) shape on a supported
 * Pinterest host. `pin.it` short links and bare pins/profiles are rejected —
 * they still surface via the fallback link above.
 */
export function isEmbeddablePinterestBoardUrl(url: string): boolean {
  const parsed = parseHttpsUrl(url);
  if (!parsed) return false;
  if (!EMBEDDABLE_BOARD_HOSTS.has(parsed.hostname)) return false;
  // A canonical board URL carries no query or fragment — reject anything that
  // does, so the strict board shape can't be smuggled past with a `?`/`#`.
  if (parsed.search !== "" || parsed.hash !== "") return false;
  return BOARD_PATH_PATTERN.test(parsed.pathname);
}
