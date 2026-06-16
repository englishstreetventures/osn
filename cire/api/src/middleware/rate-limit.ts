import type { RateLimiterBackend } from "@shared/rate-limit";
import type { MiddlewareHandler } from "hono";

import { getClientIp } from "../lib/client-ip";

/**
 * Hono middleware enforcing per-IP rate limiting via @shared/rate-limit.
 * Returns 429 with Retry-After when the limit is exceeded.
 *
 * Fails closed (C4): when the client IP cannot be resolved from the trusted
 * `cf-connecting-ip` header — which behind Cloudflare should never happen — we
 * deny the request rather than waving it through or bucketing it under a shared
 * `"unknown"` key. These limiters gate pre-auth state-changing routes, so an
 * unresolved IP is treated as a deny.
 */
export function rateLimitMiddleware(limiter: RateLimiterBackend): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c.req.raw.headers);
    if (ip === null) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many requests" }, 429);
    }

    const allowed = await limiter.check(ip);
    if (!allowed) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many requests" }, 429);
    }

    return next();
  };
}
