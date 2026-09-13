/**
 * CSRF origin guard (C5 / S-L3 cire) — Copenhagen Book M1.
 *
 * The guest `cire_session` cookie carries auth state, so cire needs CSRF
 * defence. `SameSite=Lax` already blocks cross-origin POST in modern browsers,
 * but defence-in-depth requires server-side `Origin` validation too.
 *
 * Validates the `Origin` header on every state-changing method (POST, PUT,
 * PATCH, DELETE), against the same allowlist CORS echoes (derived from
 * `WEB_ORIGIN`). When no allowlist is configured (local dev with an empty set),
 * validation is skipped so the dev server stays usable.
 *
 * Implemented as a root-level Elysia `onBeforeHandle` (mounted before most of
 * the route factories in `createApp`) so it gates the app uniformly.
 *
 * ## The exemptions
 *
 * Two of cire's server-to-server routes sidestep this by being mounted BEFORE
 * the guard — a global `onBeforeHandle` only applies to what comes after it —
 * and that is the pattern to prefer: the CSP violation collector and the
 * internal revoke endpoint. A third cannot use it. `POST /api/stripe/webhook`
 * is mounted last on purpose (the fluent chain's inferred type is erased there
 * to stay under TypeScript's instantiation-depth limit, and moving that mount
 * earlier would erase every route's types for Eden), so it needs a path
 * exemption instead — see `EXEMPT_PATHS`.
 */

import { Elysia } from "elysia";

import { metricOriginGuardRejection } from "../metrics";

/** Methods that mutate state and therefore require Origin validation. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths authenticated by something other than the caller's origin, matched
 * exactly.
 *
 * Stripe delivers webhooks server-to-server with **no `Origin` header at all**,
 * so the guard's missing-Origin branch would 403 every real delivery before its
 * signature was ever checked — and Stripe would retry the 403 for days. There
 * is nothing to protect here that Origin protects: the request carries no
 * cookie and borrows no ambient authority, and the route's own
 * `stripe-signature` check is what actually authenticates it. An unsigned body
 * still gets a 400 from the handler.
 *
 * Exact match, not a prefix: a future `/api/stripe/webhook-x` must not inherit
 * the exemption by being spelled similarly.
 */
const EXEMPT_PATHS = new Set(["/api/stripe/webhook"]);

/** The path of a request URL, without paying for a full `new URL()`. */
function pathnameOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2);
  if (start < 0) return "/";
  const path = url.slice(start);
  const query = path.indexOf("?");
  return query < 0 ? path : path.slice(0, query);
}

/**
 * Elysia plugin that 403s state-changing requests whose `Origin` is missing or
 * not in `allowedOrigins`. An empty allowlist disables the guard (dev).
 */
export function originGuard(allowedOrigins: readonly string[]) {
  const allow = new Set(allowedOrigins);
  return new Elysia().onBeforeHandle({ as: "global" }, ({ request, set }) => {
    if (!STATE_CHANGING.has(request.method)) return;
    // Dev / no allowlist configured — skip.
    if (allow.size === 0) return;
    if (EXEMPT_PATHS.has(pathnameOf(request.url))) return;

    const origin = request.headers.get("origin");
    if (!origin) {
      metricOriginGuardRejection("missing");
      set.status = 403;
      return { error: "forbidden", message: "Missing Origin header" };
    }
    if (!allow.has(origin)) {
      metricOriginGuardRejection("mismatch");
      set.status = 403;
      return { error: "forbidden", message: "Origin not allowed" };
    }
  });
}
