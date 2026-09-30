/**
 * Security response headers for the guest site's SSR responses.
 *
 * WHY THIS LIVES IN MIDDLEWARE (not `public/_headers`):
 * `cire/invites` is an SSR **Worker** (`@astrojs/cloudflare`, `output: "server"`),
 * deployed as `cire-invites`. Cloudflare Workers Static Assets DOES honour a
 * `_headers` file — but ONLY for responses served by the **static-asset layer**
 * (the prerendered `/privacy` + `/terms` pages and the `/_astro/*` bundles).
 * The dynamic invite routes (`/<slug>` and the bare-domain `/` redirect) are
 * produced by the **Worker script** (`dist/server/entry.mjs`), which the asset
 * `_headers` layer never touches. So before this module the security headers
 * were MISSING on exactly the most sensitive pages — the guest invites. The
 * Astro `onRequest` middleware (`src/middleware.ts`) attaches these headers to
 * every SSR HTML response; `public/_headers` is kept in sync to cover the
 * static-asset paths (and to document intent). That file is written for
 * production and the build points its copy at this build's cire-api
 * (`lib/tier-headers.ts`), the same origin {@link API_ORIGIN} names here.
 *
 * NB: Astro middleware does NOT run for prerendered routes at request time
 * (they are served straight from the asset layer), which is exactly why we keep
 * `public/_headers` for those.
 *
 * The CSP allowlist is derived from an audit of every external origin the guest
 * site actually loads — see `CSP_DIRECTIVES` below for the per-origin rationale.
 */

import { apiPreconnectHref, PRODUCTION_API_ORIGIN } from "./api-origin";
import { API_URL } from "./invite";

export { PRODUCTION_API_ORIGIN };

/**
 * The origin of the cire-api this build calls — the `PUBLIC_API_URL` baked in
 * at build time (`lib/invite.ts`), so each tier's policy names its own API and
 * its own report collector: production, dev, the portless devloop's
 * `api.cire.localhost`, or `http://localhost:8787` when the env is unset. The
 * build fails on an API URL that is not a plain http(s) origin
 * (`lib/tier-headers.ts`), so the fallback here only keeps a module load from
 * throwing; it never ships. It is the URL itself rather than a second origin
 * literal, so the server bundle names no API it was not built for, and the
 * build's check that it names the header's origin means something.
 */
export const API_ORIGIN = apiPreconnectHref(API_URL) ?? API_URL;

/**
 * Third-party origins the guest site genuinely talks to, grouped by purpose.
 * Everything here is an explicit allowlist, with no wildcard. The first-party
 * cire-api origin is not listed: it differs per build, so {@link cspDirectives}
 * takes it as an argument.
 */
const ORIGINS = {
  // No OSN issuer origin here on purpose. The "Link my Pulse account" flow
  // signs in by TOP-LEVEL redirect to musubi and cire-api does the code
  // exchange, so the guest site never fetches a second origin. A top-level
  // navigation is not a `connect-src` subject, so nothing needs to be
  // allowlisted for it.
  // Pinterest moodboard widget (PinterestBoard.tsx / pinterest.ts).
  pinterestScript: "https://assets.pinterest.com", // pinit_main.js
  pinterestConnect: "https://widgets.pinterest.com", // pidgets data fetch
  pinterestImg: "https://i.pinimg.com", // pin thumbnails
  pinterestFrame: "https://assets.pinterest.com", // rendered board iframe
  // Google Maps Embed (MapPreview.tsx -> resolveMapsEmbedUrl).
  googleMapsFrame: "https://www.google.com", // /maps/embed iframe host
  googleMapsImg: "https://maps.gstatic.com", // map tiles / static assets
  googleMapsImg2: "https://maps.googleapis.com", // map tile requests
  // Cloudflare Turnstile (guest claim flow — LoginSection -> TurnstileWidget).
  turnstile: "https://challenges.cloudflare.com", // api.js + challenge iframe
} as const;

/**
 * The first-party CSP violation-report collector for `apiOrigin` — the
 * `POST /api/csp-report` route on that cire-api. The guest CSP's `report-uri`
 * (legacy, widely supported) and `report-to` (modern Reporting API) both
 * target it; the `report-to` group is named by {@link REPORTING_ENDPOINT_NAME}
 * and resolved via the `Reporting-Endpoints` response header
 * ({@link reportingEndpointsHeader}). Each tier reports to its own API, so dev
 * reports never reach the production collector.
 *
 * NB: while the policy is Report-Only it STILL sends reports — that is the whole
 * point of pointing it at a collector.
 */
export function cspReportEndpoint(apiOrigin: string = API_ORIGIN): string {
  return `${apiOrigin}/api/csp-report`;
}

/** This build's collector. */
export const CSP_REPORT_ENDPOINT = cspReportEndpoint();

/** The `report-to` group name, shared by the CSP directive + the header. */
export const REPORTING_ENDPOINT_NAME = "csp-endpoint" as const;

/**
 * The Content-Security-Policy as a structured, ordered map of
 * directive -> source list. Built into the header string by {@link buildCsp}.
 *
 * INLINE SCRIPT / STYLE HANDLING (why the two `'unsafe-inline'` relaxations):
 *
 *  - `script-src` keeps `'unsafe-inline'`. Astro's SSR island hydration emits
 *    small inline `<script>` blocks (the `<astro-island>` custom-element
 *    definition + the per-directive `client:load` / `client:visible` bootstrap).
 *    These cannot be covered by a hash or nonce from a single response header
 *    (Astro's own CSP hashing only works via a `<meta>` tag that cannot express
 *    `frame-ancestors` and would conflict with this header). `'unsafe-inline'`
 *    is therefore required for hydration to work — but `script-src` stays
 *    host-restricted (no wildcard; only `'self'` + the two audited third-party
 *    script hosts), so injected *external* scripts are still blocked. This is
 *    the documented, provably-working relaxation.
 *
 *  - `style-src` / `style-src-attr` keep `'unsafe-inline'`. The invite renders
 *    many element `style={{...}}` theme variables (governed by `style-src-attr`),
 *    Astro emits an inline `<style>` island reset, and Tailwind/Astro inject
 *    inline styles. Element style attributes needing `'unsafe-inline'` is
 *    expected and low-risk (they cannot execute script).
 *
 * Locked-down directives: `frame-ancestors 'none'` (clickjacking — note this is
 * header-only; it is ignored inside a `<meta>` CSP, another reason the policy
 * lives in the response header), `object-src 'none'`, `base-uri 'self'`.
 */
export function cspDirectives(apiOrigin: string = API_ORIGIN) {
  return {
    "default-src": ["'self'"],
    // Astro island hydration inline scripts need 'unsafe-inline'; hosts are
    // still tightly allowlisted (no wildcard).
    "script-src": ["'self'", "'unsafe-inline'", ORIGINS.pinterestScript, ORIGINS.turnstile],
    // Astro/Tailwind inline styles. Fonts are self-hosted — the
    // @font-face rules load from 'self', no third-party stylesheet host needed.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Inline element style attributes (the invite theme vars). Low-risk.
    "style-src-attr": ["'unsafe-inline'"],
    // Self-hosted fontsource woff2 files — served from 'self'.
    "font-src": ["'self'"],
    // First-party invite/event image bytes (served from cire-api), Pinterest pin
    // thumbnails, Google Maps tiles, plus data:/blob: (inline SVG/blur placeholders).
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      apiOrigin,
      ORIGINS.pinterestImg,
      ORIGINS.googleMapsImg,
      ORIGINS.googleMapsImg2,
    ],
    // Runtime fetches: cire-api (claim, the invite JSON retry, account-link,
    // including the session probe behind the Pulse account-link panel) and the
    // Pinterest pidgets data endpoint the widget calls.
    "connect-src": ["'self'", apiOrigin, ORIGINS.pinterestConnect],
    // Embedded iframes: the Google Maps embed, the Pinterest board widget, and
    // the Turnstile challenge.
    "frame-src": ["'self'", ORIGINS.googleMapsFrame, ORIGINS.pinterestFrame, ORIGINS.turnstile],
    // Clickjacking defence (header-only directive — ignored in <meta>).
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    // Reporting: where the browser sends CSP violation reports (works in
    // Report-Only too — that is the point). `report-uri` is the legacy, broadly
    // supported directive (a URL); `report-to` is the modern Reporting API
    // directive (a GROUP NAME resolved by the `Reporting-Endpoints` header, set
    // alongside this CSP — see `securityHeaders`). We ship BOTH for coverage
    // across browser versions. Both target the first-party cire-api collector
    // (`cspReportEndpoint`) — no third-party service.
    "report-uri": [cspReportEndpoint(apiOrigin)],
    "report-to": [REPORTING_ENDPOINT_NAME],
  } as const satisfies Record<string, readonly string[]>;
}

/** This build's policy, as a directive map. */
export const CSP_DIRECTIVES = cspDirectives();

/** Serialise the directive map into a single CSP header value. */
export function buildCsp(directives: Record<string, readonly string[]> = CSP_DIRECTIVES): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length > 0 ? `${name} ${sources.join(" ")}` : name))
    .join("; ");
}

/**
 * CSP rollout mode. While `false` (the default) the policy ships as
 * `Content-Security-Policy-Report-Only`: the browser reports what WOULD be
 * blocked but blocks NOTHING, so a missing allowlist entry can never break the
 * live invite. After a real-browser smoke test on the deployed site confirms
 * zero violations (load an invite + fonts + hero image, open a Pinterest
 * moodboard, the Maps embed, and submit a claim with DevTools open), flip this
 * to `true` to enforce. That one-line change is the entire enforce step.
 */
export const CSP_ENFORCE = false;

/** The CSP header name for the current rollout mode. */
export function cspHeaderName(): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

/**
 * The `Reporting-Endpoints` header value that resolves the CSP `report-to`
 * group name to the first-party collector URL — `csp-endpoint="<url>"`. Required
 * for the modern Reporting API path to deliver anything (the legacy `report-uri`
 * directive needs no companion header). Mirrors {@link cspReportEndpoint}.
 */
export function reportingEndpointsHeader(apiOrigin: string = API_ORIGIN): string {
  return `${REPORTING_ENDPOINT_NAME}="${cspReportEndpoint(apiOrigin)}"`;
}

/**
 * The full set of security headers attached to every SSR HTML response. The CSP,
 * `Reporting-Endpoints` and the four hardening headers mirror `public/_headers`,
 * because that file does not apply to SSR Worker responses (see the module doc
 * above).
 *
 * `X-Robots-Tag` is the exception: SSR-only, and deliberately absent from
 * `public/_headers`. The SSR routes are the invite (`/<slug>`), the gift page
 * (`/<slug>/registry`) and the bare-domain redirect; the first two carry a
 * couple's names and photo and are meant for invited guests, so they stay out
 * of search indexes. It is a header rather than a `robots.txt` disallow because
 * a crawler that obeys a disallow never fetches the page to see a `noindex`,
 * and a disallowed URL can still be indexed from links elsewhere. The
 * prerendered `/privacy` and `/terms` never reach the middleware, so they stay
 * indexable.
 *
 * The CSP ships in Report-Only mode until {@link CSP_ENFORCE} is flipped — see
 * its doc. The non-CSP headers are always enforced (they carry no breakage
 * risk).
 */
export function securityHeaders(apiOrigin: string = API_ORIGIN) {
  return {
    [cspHeaderName()]: buildCsp(cspDirectives(apiOrigin)),
    // Resolves the CSP `report-to csp-endpoint` group to the first-party
    // collector. Harmless when only `report-uri` is honoured by the browser.
    "Reporting-Endpoints": reportingEndpointsHeader(apiOrigin),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Robots-Tag": "noindex, nofollow",
  } satisfies Record<string, string>;
}

/**
 * The header set, built once at module load. Every input is a module constant,
 * so rebuilding it — CSP string included — on each response would produce the
 * same entries every time.
 */
const SECURITY_HEADER_ENTRIES = Object.entries(securityHeaders());

/**
 * Apply the security headers to a response's `Headers`. Only sets a header that
 * is not already present, so a route that deliberately set its own value wins.
 */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of SECURITY_HEADER_ENTRIES) {
    if (!headers.has(name)) headers.set(name, value);
  }
}
