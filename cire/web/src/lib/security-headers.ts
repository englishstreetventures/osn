/**
 * Security response headers for the guest site's SSR responses.
 *
 * WHY THIS LIVES IN MIDDLEWARE (not `public/_headers`):
 * `cire/web` is an SSR **Worker** (`@astrojs/cloudflare`, `output: "server"`),
 * deployed as `cire-invites`. Cloudflare Workers Static Assets DOES honour a
 * `_headers` file — but ONLY for responses served by the **static-asset layer**
 * (the prerendered `/privacy` + `/terms` pages and the `/_astro/*` bundles).
 * The dynamic invite routes (`/<slug>` and the bare-domain `/` redirect) are
 * produced by the **Worker script** (`dist/server/entry.mjs`), which the asset
 * `_headers` layer never touches. So before this module the security headers
 * were MISSING on exactly the most sensitive pages — the guest invites. The
 * Astro `onRequest` middleware (`src/middleware.ts`) attaches these headers to
 * every SSR HTML response; `public/_headers` is kept in sync to cover the
 * static-asset paths (and to document intent).
 *
 * NB: Astro middleware does NOT run for prerendered routes at request time
 * (they are served straight from the asset layer), which is exactly why we keep
 * `public/_headers` for those.
 *
 * The CSP allowlist is derived from an audit of every external origin the guest
 * site actually loads — see `CSP_DIRECTIVES` below for the per-origin rationale.
 */

/**
 * Origins the guest site genuinely talks to, grouped by purpose. Production
 * hosts are the source of truth; the localhost entries keep `astro dev` / a
 * local `wrangler dev` working without loosening production. Everything here is
 * an explicit allowlist — no wildcards beyond the first-party scheme hosts.
 */
const ORIGINS = {
  /** First-party cire-api (invite JSON fetch + invite/event image bytes). */
  api: "https://api.cireweddings.com",
  /** Local dev API origin (the PUBLIC_API_URL default in `lib/invite.ts`). */
  apiLocal: "http://localhost:8787",
  // Pinterest moodboard widget (PinterestBoard.tsx / pinterest.ts).
  pinterestScript: "https://assets.pinterest.com", // pinit_main.js
  pinterestConnect: "https://widgets.pinterest.com", // pidgets data fetch
  pinterestImg: "https://i.pinimg.com", // pin thumbnails
  pinterestFrame: "https://assets.pinterest.com", // rendered board iframe
  // Google Maps Embed (MapPreview.tsx -> resolveMapsEmbedUrl).
  googleMapsFrame: "https://www.google.com", // /maps/embed iframe host
  googleMapsImg: "https://maps.gstatic.com", // map tiles / static assets
  googleMapsImg2: "https://maps.googleapis.com", // map tile requests
  // Google Fonts (Cormorant Garamond + Lato), loaded in the Astro head.
  fontsStyle: "https://fonts.googleapis.com", // the @font-face stylesheet
  fontsFile: "https://fonts.gstatic.com", // the woff2 font files
  // Cloudflare Turnstile (guest claim flow — LoginSection -> TurnstileWidget).
  turnstile: "https://challenges.cloudflare.com", // api.js + challenge iframe
} as const;

/**
 * First-party CSP violation-report collector — the `POST /api/csp-report` route
 * on cire-api. Derived from the SAME {@link ORIGINS.api} const that `connect-src`
 * / `img-src` already reference, so the report origin can never drift from the
 * audited cire-api origin. The guest CSP's `report-uri` (legacy, widely
 * supported) and `report-to` (modern Reporting API) both target this URL; the
 * `report-to` group is named by {@link REPORTING_ENDPOINT_NAME} and resolved via
 * the `Reporting-Endpoints` response header ({@link reportingEndpointsHeader}).
 *
 * NB: while the policy is Report-Only it STILL sends reports — that is the whole
 * point of pointing it at a collector. The endpoint stays production (cire-api
 * `localhost:8787` has no public collector in dev and we don't want dev noise);
 * a local report simply fails to POST, which is harmless.
 */
export const CSP_REPORT_ENDPOINT = `${ORIGINS.api}/api/csp-report` as const;

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
 *    definition + the per-directive `client:load` / `client:visible` bootstrap),
 *    and the font `<link rel="preload" ... onload="...">` in the document heads
 *    is an inline event-handler attribute. Neither can be covered by a hash or
 *    nonce from a single response header (event-handler attributes are never
 *    hash-eligible, and Astro's own CSP hashing only works via a `<meta>` tag
 *    that cannot express `frame-ancestors` and would conflict with this header).
 *    `'unsafe-inline'` is therefore required for hydration to work — but
 *    `script-src` stays host-restricted (no wildcard; only `'self'` + the two
 *    audited third-party script hosts), so injected *external* scripts are still
 *    blocked. This is the documented, provably-working relaxation.
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
export const CSP_DIRECTIVES: Record<string, readonly string[]> = {
  "default-src": ["'self'"],
  // Astro island hydration inline scripts + the font-link onload handler need
  // 'unsafe-inline'; hosts are still tightly allowlisted (no wildcard).
  "script-src": ["'self'", "'unsafe-inline'", ORIGINS.pinterestScript, ORIGINS.turnstile],
  // Google Fonts stylesheet + Astro/Tailwind inline styles.
  "style-src": ["'self'", "'unsafe-inline'", ORIGINS.fontsStyle],
  // Inline element style attributes (the invite theme vars). Low-risk.
  "style-src-attr": ["'unsafe-inline'"],
  // Google Fonts woff2 files.
  "font-src": ["'self'", ORIGINS.fontsFile],
  // First-party invite/event image bytes (served from cire-api), Pinterest pin
  // thumbnails, Google Maps tiles, plus data:/blob: (inline SVG/blur placeholders).
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    ORIGINS.api,
    ORIGINS.apiLocal,
    ORIGINS.pinterestImg,
    ORIGINS.googleMapsImg,
    ORIGINS.googleMapsImg2,
  ],
  // Runtime fetches: cire-api (invite JSON + revalidation) and the Pinterest
  // pidgets data endpoint the widget calls.
  "connect-src": ["'self'", ORIGINS.api, ORIGINS.apiLocal, ORIGINS.pinterestConnect],
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
  // (`CSP_REPORT_ENDPOINT`) — no third-party service.
  "report-uri": [CSP_REPORT_ENDPOINT],
  "report-to": [REPORTING_ENDPOINT_NAME],
} as const;

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
 * directive needs no companion header). Mirrors {@link CSP_REPORT_ENDPOINT}.
 */
export function reportingEndpointsHeader(): string {
  return `${REPORTING_ENDPOINT_NAME}="${CSP_REPORT_ENDPOINT}"`;
}

/**
 * The full set of security headers attached to every SSR HTML response. The CSP
 * mirrors `public/_headers`; the other four headers re-assert the same intent
 * `public/_headers` documents, because that file does not apply to SSR Worker
 * responses (see the module doc above).
 *
 * The CSP ships in Report-Only mode until {@link CSP_ENFORCE} is flipped — see
 * its doc. The non-CSP headers are always enforced (they carry no breakage
 * risk).
 */
export function securityHeaders(): Record<string, string> {
  return {
    [cspHeaderName()]: buildCsp(),
    // Resolves the CSP `report-to csp-endpoint` group to the first-party
    // collector. Harmless when only `report-uri` is honoured by the browser.
    "Reporting-Endpoints": reportingEndpointsHeader(),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

/**
 * Apply the security headers to a response's `Headers`. Only sets a header that
 * is not already present, so a route that deliberately set its own value wins.
 */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(securityHeaders())) {
    if (!headers.has(name)) headers.set(name, value);
  }
}
