/**
 * Origin header validation middleware (Copenhagen Book M1).
 *
 * Once cookies carry auth state, CSRF protection is needed. SameSite=Lax
 * blocks cross-origin POST in modern browsers, but defense-in-depth requires
 * server-side Origin validation.
 *
 * Validates the Origin header for all state-changing methods (POST, PUT,
 * PATCH, DELETE). Skips validation only for a request that carries its own
 * credentials in `Authorization` (an S2S ARC token anywhere, or the service
 * secret under the internal prefixes) and for the OAuth token endpoint.
 */

import type { OriginGuardRejectionReason } from "@shared/observability/metrics";
import type { Context as ElysiaContext } from "elysia";

import { metricOriginGuardRejection } from "../metrics";

/** HTTP methods that change state and require Origin validation. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * URL path prefixes of the internal route factories mounted in `app.ts`:
 * `/graph/internal` (graph-internal), `/organisations/internal`
 * (organisation-internal), `/internal` (internal-account). Matched on a
 * segment boundary (prefix must be followed by `/`, `?` or end-of-path) so a
 * route like `/graph/internal-x` is NOT exempted.
 *
 * A path here is exempt only with `Authorization: Bearer …` — the
 * `INTERNAL_SERVICE_SECRET` that `/graph/internal/register-service` and
 * `/graph/internal/service-keys/:keyId` compare. Without a credential header a
 * request here is Origin-checked like any other, so a cookie-bearing browser
 * request cannot reach these paths unchecked. `/organisations/internal…` also
 * matches the user organisation routes for a handle `internal`; those
 * authenticate by Bearer access token only and read no cookie, so the
 * exemption gives a cross-site request nothing to borrow there either.
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

/**
 * The dev sign-in form's POST. Matched on the exact path, not a prefix, so
 * `/dev/login/form-x` is still Origin-checked. The route is mounted only on the
 * local and dev tiers, and it needs the dev secret in its body: a cross-site
 * form has no ambient authority to borrow and no secret to send.
 */
const DEV_FORM_PATHS = new Set(["/dev/login/form"]);

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

    // Extract the pathname without a full URL parse to avoid a per-request
    // allocation.
    const pathStart = request.url.indexOf("/", request.url.indexOf("//") + 2);
    const path = pathStart >= 0 ? request.url.slice(pathStart) : request.url;
    // The service secret, under the internal prefixes only. Like the ARC
    // header, a browser cannot attach it cross-site without a CORS preflight
    // our allowlist rejects, and the routes compare it in constant time. A
    // Bearer access token on any other path is still Origin-checked.
    if (authorization && /^Bearer\s/i.test(authorization) && matchesPrefix(path, S2S_PREFIXES)) {
      return;
    }
    if (matchesPrefix(path, OAUTH_S2S_PREFIXES)) return;
    if (DEV_FORM_PATHS.has(path.split("?", 1)[0] ?? "")) return;

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
