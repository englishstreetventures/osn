/**
 * CSRF origin guard (C5 / S-L3 cire) — Copenhagen Book M1.
 *
 * The guest `cire_session` cookie carries auth state, so cire needs CSRF
 * defence. `SameSite=Lax` already blocks cross-origin POST in modern browsers,
 * but defence-in-depth requires server-side `Origin` validation too.
 *
 * Validates the `Origin` header on every state-changing method (POST, PUT,
 * PATCH, DELETE). cire has NO inbound ARC / S2S routes (unlike osn-api, whose
 * origin guard exempts them), so there is no exemption — every state-changing
 * request is checked against the same allowlist CORS echoes (derived from
 * `WEB_ORIGIN`). When no allowlist is configured (local dev with an empty set),
 * validation is skipped so the dev server stays usable.
 *
 * Implemented as a root-level Elysia `onBeforeHandle` (mounted before the route
 * factories in `createApp`) so it gates the whole app uniformly.
 */

import { Elysia } from "elysia";

import { metricOriginGuardRejection } from "../metrics";

/** Methods that mutate state and therefore require Origin validation. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
