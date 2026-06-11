/**
 * Pinterest URL validator.
 *
 * `pinterestUrl` arrives as server-supplied free text from the claim response.
 * Before it lands in `<a href=...>` or as input to Pinterest's embed script,
 * `isValidPinterestUrl` must accept it — the gate rejects `javascript:` URIs,
 * foreign hosts, and malformed paths.
 *
 * Defence in depth: the regex restricts path segments to a strict character
 * set (no whitespace, `?`, `#`, etc.) AND the URL is re-parsed via the `URL`
 * constructor with an explicit host allowlist, so a future regex regression
 * can't slip a foreign host through.
 */

// Path segments allow letters, digits, and the URL-safe symbols Pinterest
// actually uses on board URLs. Permits `-`, `.`, `_`, `~`, `%` (percent-encoded
// chars) but rejects `?`, `#`, whitespace, and other shell-y characters.
const PATH_SEGMENT = "[A-Za-z0-9._~%-]+";
const PINTEREST_BOARD_PATTERN = new RegExp(
  `^https://(www\\.)?pinterest\\.(com|com\\.au|co\\.uk)/${PATH_SEGMENT}/${PATH_SEGMENT}/?$`,
);

const ALLOWED_HOSTS = new Set([
  "pinterest.com",
  "www.pinterest.com",
  "pinterest.com.au",
  "www.pinterest.com.au",
  "pinterest.co.uk",
  "www.pinterest.co.uk",
]);

export function isValidPinterestUrl(url: string): boolean {
  if (!PINTEREST_BOARD_PATTERN.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname);
}
