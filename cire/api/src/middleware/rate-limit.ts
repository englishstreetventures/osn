import type { RateLimiterBackend } from "@shared/rate-limit";
import { Elysia } from "elysia";

import { getClientIp } from "../lib/client-ip";

/**
 * Elysia plugin enforcing per-IP rate limiting via @shared/rate-limit.
 * Returns 429 with Retry-After when the limit is exceeded.
 */
export function rateLimitMiddleware(limiter: RateLimiterBackend) {
  return new Elysia().onBeforeHandle({ as: "scoped" }, async ({ request, set }) => {
    const ip = getClientIp(request.headers);
    const allowed = await limiter.check(ip);

    if (!allowed) {
      set.status = 429;
      set.headers["retry-after"] = "60";
      return { error: "Too many requests" };
    }
  });
}
