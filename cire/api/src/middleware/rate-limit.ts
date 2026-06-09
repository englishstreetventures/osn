import type { MiddlewareHandler } from "hono";

import type { RateLimiter } from "../services/rate-limit";
import { getClientIp } from "../services/rate-limit";

/**
 * Hono middleware factory that enforces per-IP rate limiting.
 * Returns 429 with Retry-After header when the limit is exceeded.
 */
export function rateLimitMiddleware(limiter: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c.req.raw.headers);
    const allowed = limiter.check(ip);

    if (!allowed) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many requests" }, 429);
    }

    return next();
  };
}
