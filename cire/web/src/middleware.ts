import type { MiddlewareHandler } from "astro";

import { applySecurityHeaders } from "./lib/security-headers";

/**
 * Astro SSR middleware — attaches the site's security headers (CSP + the four
 * classic hardening headers) to every server-rendered response.
 *
 * This is the REAL home for these headers on the guest site: `cire/web` is an
 * SSR Worker (`@astrojs/cloudflare`), and the `public/_headers` file only
 * applies to the static-asset layer (prerendered `/privacy` + `/terms` and
 * `/_astro/*`) — NOT to the Worker-rendered invite routes (`/<slug>`, `/`).
 * See `lib/security-headers.ts` for the full rationale and the CSP audit.
 *
 * We harden every SSR response, including the bare-domain 302 redirect (cheap,
 * and keeps `frame-ancestors`/`X-Frame-Options` on the redirect document too).
 * `applySecurityHeaders` is non-clobbering, so a route that set its own value
 * for one of these headers still wins.
 */
export const onRequest: MiddlewareHandler = async (_context, next) => {
  const response = await next();
  applySecurityHeaders(response.headers);
  return response;
};
