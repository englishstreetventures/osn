/**
 * Origin header validation middleware (Copenhagen Book M1 — CSRF defence).
 *
 * Ported from `osn/api/src/lib/origin-guard.ts` (S-L3 cire). The guest
 * `cire_session` cookie carries auth state, so cire needs CSRF protection.
 * `SameSite=Lax` already blocks cross-origin POST in modern browsers, but
 * defence-in-depth requires server-side Origin validation too.
 *
 * Validates the `Origin` header for all state-changing methods (POST, PUT,
 * PATCH, DELETE). Unlike osn-api, cire has NO inbound ARC / S2S routes, so
 * there is no exemption — every state-changing request is checked. When no
 * allowlist is configured (local dev), validation is skipped.
 */

import type { MiddlewareHandler } from "hono";

import { metricOriginGuardRejection } from "../metrics";

/** HTTP methods that change state and require Origin validation. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginGuardConfig {
  /**
   * Allowed origins (the same set CORS echoes, derived from `WEB_ORIGIN`).
   * Empty ⇒ skip validation (dev mode, no allowlist configured).
   */
  allowedOrigins: Set<string>;
}

/**
 * Returns a Hono middleware that validates the `Origin` header on
 * state-changing requests. Responds 403 on a missing or mismatched Origin
 * when an allowlist is configured; otherwise calls `next()`.
 */
export function originGuard(config: OriginGuardConfig): MiddlewareHandler {
  return async (c, next) => {
    // Skip non-state-changing methods (GET, HEAD, OPTIONS).
    if (!STATE_CHANGING_METHODS.has(c.req.method)) return next();

    // Dev mode (no allowlist configured) — skip validation.
    if (config.allowedOrigins.size === 0) return next();

    const origin = c.req.header("Origin");

    if (!origin) {
      metricOriginGuardRejection("missing");
      return c.json({ error: "forbidden", message: "Missing Origin header" }, 403);
    }

    if (!config.allowedOrigins.has(origin)) {
      metricOriginGuardRejection("mismatch");
      return c.json({ error: "forbidden", message: "Origin not allowed" }, 403);
    }

    return next();
  };
}
