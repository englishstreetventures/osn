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

/** URL path prefixes that use S2S ARC tokens, not cookies. */
const S2S_PREFIXES = ["/graph/internal", "/organisation-internal"];

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

    // Skip for S2S endpoints — they use ARC tokens, not cookies.
    // P-W1: extract pathname without full URL parse to avoid per-request allocation.
    const pathStart = request.url.indexOf("/", request.url.indexOf("//") + 2);
    const path = pathStart >= 0 ? request.url.slice(pathStart) : request.url;
    if (S2S_PREFIXES.some((prefix) => path.startsWith(prefix))) return;

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
