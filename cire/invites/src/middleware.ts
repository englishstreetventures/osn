import type { MiddlewareHandler } from "astro";

import { applySecurityHeaders } from "./lib/security-headers";

/**
 * Astro SSR middleware — attaches the site's security headers (CSP, the
 * hardening headers and `X-Robots-Tag: noindex`) to every server-rendered
 * response.
 *
 * This is the REAL home for these headers on the guest site: `cire/invites` is an
 * SSR Worker (`@astrojs/cloudflare`), and the `public/_headers` file only
 * applies to the static-asset layer (prerendered `/privacy` + `/terms`,
 * `/_astro/*` and the other files in `public/`, such as `/robots.txt` and
 * `/favicon.ico`) — NOT to the Worker-rendered invite routes (`/<slug>`, `/`).
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
  // The palette `style` sits before `<meta charset>` in the document, so the
  // declaration can start past the first 1,024 bytes the HTML standard allows.
  // The header pins the encoding for the whole response instead.
  const type = response.headers.get("Content-Type");
  if (type?.startsWith("text/html") && !/charset=/i.test(type)) {
    response.headers.set("Content-Type", "text/html; charset=utf-8");
  }
  return response;
};
