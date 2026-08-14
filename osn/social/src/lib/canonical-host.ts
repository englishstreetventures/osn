// The production bundle answers on two hostnames. One is the custom domain,
// `musubi.social`. The other is `osn-social.pages.dev`, the default subdomain
// Cloudflare gives every Pages project and offers no switch to turn off.
//
// Nothing works on the second one. The WebAuthn RP ID is `musubi.social`, so no
// passkey ceremony can run there, and the API's CORS allowlist names only the
// custom domain, so every call it makes is refused — after the request has been
// paid for at the edge. A crawler fleet in AWS us-west-2 found that copy and
// spent roughly 33k requests a day on token grants that could never succeed.
//
// So the pages.dev copy hands the visitor to the real origin before the app
// boots. Preview deployments (`<branch>.osn-social.pages.dev`) are left alone on
// purpose — reviewing a PR on its preview URL is the point of them, and they
// were never what the fleet was hitting.

const PAGES_DEV_HOST = "osn-social.pages.dev";
const CANONICAL_ORIGIN = "https://musubi.social";

/**
 * Where `href` should be sent instead, or `null` to stay put.
 *
 * Path, query and fragment ride along, so a shared deep link still lands where
 * it meant to. An unparseable href is left alone: a redirect is a worse answer
 * than doing nothing when we cannot tell what we are looking at.
 */
export function canonicalRedirectTarget(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== PAGES_DEV_HOST) return null;
  return `${CANONICAL_ORIGIN}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Send the browser to the canonical origin if it is on the pages.dev copy.
 *
 * Returns whether a redirect was started. `location.replace` does not stop the
 * script that called it, so the caller has to skip the app boot itself —
 * otherwise the session grant still fires while the new document loads, which
 * is the exact request this is here to stop. Inert with no `window` (tests,
 * any non-browser build).
 */
export function redirectToCanonicalHost(): boolean {
  if (typeof window === "undefined") return false;
  const target = canonicalRedirectTarget(window.location.href);
  if (target === null) return false;
  window.location.replace(target);
  return true;
}
