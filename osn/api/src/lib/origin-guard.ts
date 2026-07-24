/**
 * Origin header validation middleware (Copenhagen Book M1).
 *
 * Once cookies carry auth state, CSRF protection is needed. SameSite=Lax
 * blocks cross-origin POST in modern browsers, but defense-in-depth requires
 * server-side Origin validation.
 *
 * Validates the Origin header for all state-changing methods (POST, PUT,
 * PATCH, DELETE). Skips validation for S2S endpoints that use ARC tokens.
 */

import type { OriginGuardRejectionReason } from "@shared/observability/metrics";
import type { Context as ElysiaContext } from "elysia";

import { metricOriginGuardRejection } from "../metrics";

/** HTTP methods that change state and require Origin validation. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * URL path prefixes that use S2S ARC tokens, not cookies. Matched on a segment
 * boundary (prefix must be followed by `/` or end-of-path) so a future route
 * like `/graph/internal-x` is NOT silently exempted. Kept as a secondary signal
 * only — the load-bearing exemption is the `Authorization: ARC` header below,
 * which cannot drift when a route is renamed.
 *
 * These MUST stay in sync with the internal route factories mounted in
 * `app.ts`: `/graph/internal` (graph-internal), `/organisations/internal`
 * (organisation-internal), `/internal` (internal-account).
 */
const S2S_PREFIXES = ["/graph/internal", "/organisations/internal", "/internal"];

/**
 * OAuth endpoints called by a relying party's server, not by a browser. They
 * carry no cookie and set none, and they authenticate the caller with its own
 * client credentials plus a PKCE verifier — so there is no ambient authority
 * for a cross-site request to borrow, which is the only thing Origin checking
 * defends. Demanding an Origin header here would simply lock out every
 * server-side client, since HTTP clients do not send one.
 */
const OAUTH_S2S_PREFIXES = ["/oidc/token"];

/** True when `path` equals a prefix or continues it at a segment boundary. */
function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    if (!path.startsWith(prefix)) return false;
    const next = path.charAt(prefix.length);
    return next === "" || next === "/" || next === "?";
  });
}

export interface OriginGuardConfig {
  /** Allowed origins (from OSN_CORS_ORIGIN). Empty = skip validation (dev mode). */
  allowedOrigins: Set<string>;
}

function recordRejection(reason: OriginGuardRejectionReason): void {
  metricOriginGuardRejection(reason);
}

/**
 * Returns an Elysia `beforeHandle` hook that validates the Origin header.
 */
export function createOriginGuard(config: OriginGuardConfig) {
  return ({ request, set }: Pick<ElysiaContext, "request" | "set">) => {
    // Skip for non-state-changing methods (GET, HEAD, OPTIONS)
    if (!STATE_CHANGING_METHODS.has(request.method)) return;

    // Skip for S2S calls. These carry `Authorization: ARC <token>` and no
    // cookie, so they are not a CSRF vector (a browser cannot attach the ARC
    // header AND send our cookies cross-origin — the header forces a CORS
    // preflight our allowlist rejects). Keying the exemption on the ARC header
    // rather than a hardcoded path list means a renamed internal route can
    // never silently lose its exemption (or, worse, a cookie route can never
    // accidentally gain one). The internal routes still verify the ARC token
    // cryptographically, so skipping Origin here grants nothing on its own.
    const authorization = request.headers.get("authorization");
    if (authorization && /^ARC\s/i.test(authorization)) return;

    // Secondary path-based signal (segment-boundary matched). P-W1: extract
    // pathname without a full URL parse to avoid a per-request allocation.
    const pathStart = request.url.indexOf("/", request.url.indexOf("//") + 2);
    const path = pathStart >= 0 ? request.url.slice(pathStart) : request.url;
    if (matchesPrefix(path, S2S_PREFIXES)) return;
    if (matchesPrefix(path, OAUTH_S2S_PREFIXES)) return;

    // In dev mode (no allowlist configured), skip validation
    if (config.allowedOrigins.size === 0) return;

    const origin = request.headers.get("origin");

    if (!origin) {
      recordRejection("missing");
      set.status = 403;
      return { error: "forbidden", message: "Missing Origin header" };
    }

    if (!config.allowedOrigins.has(origin)) {
      recordRejection("mismatch");
      set.status = 403;
      return { error: "forbidden", message: "Origin not allowed" };
    }
  };
}
