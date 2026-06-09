import type { RateLimiterBackend } from "@shared/rate-limit";
import type { MiddlewareHandler } from "hono";

import { getClientIp } from "../lib/client-ip";

/**
 * Hono middleware enforcing per-IP rate limiting via @shared/rate-limit.
 * Returns 429 with Retry-After when the limit is exceeded.
 */
export function rateLimitMiddleware(limiter: RateLimiterBackend): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c.req.raw.headers);
    const allowed = await limiter.check(ip);

    if (!allowed) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many requests" }, 429);
    }

    return next();
  };
}
