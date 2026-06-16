import type { RateLimiterBackend } from "@shared/rate-limit";
import { Elysia } from "elysia";

import { getClientIp, isUnresolvedIp } from "../lib/client-ip";

/**
 * Elysia plugin enforcing per-IP rate limiting via @shared/rate-limit.
 * Returns 429 with Retry-After when the limit is exceeded.
 *
 * C4 fail-closed: when the client IP cannot be resolved (no/invalid
 * `cf-connecting-ip` — e.g. a request that somehow reached the Worker without
 * passing Cloudflare's edge), the request is denied with 429 rather than keyed
 * on a shared fallback bucket. Bucketing unresolved requests together is both a
 * DoS amplifier (one caller drains everyone's budget) and a spoofing bypass, so
 * "deny" is the only safe posture on a pre-auth credential surface.
 */
export function rateLimitMiddleware(limiter: RateLimiterBackend) {
  return new Elysia().onBeforeHandle({ as: "scoped" }, async ({ request, set }) => {
    const ip = getClientIp(request.headers);

    if (isUnresolvedIp(ip)) {
      set.status = 429;
      set.headers["retry-after"] = "60";
      return { error: "Too many requests" };
    }

    const allowed = await limiter.check(ip);

    if (!allowed) {
      set.status = 429;
      set.headers["retry-after"] = "60";
      return { error: "Too many requests" };
    }
  });
}
