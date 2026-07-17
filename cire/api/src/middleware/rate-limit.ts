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

/**
 * Elysia plugin enforcing per-USER rate limiting via @shared/rate-limit.
 * Keys on `osnProfileId` derived by upstream `osnAuth()` rather than on the
 * client IP, so each authenticated organiser has their own independent bucket.
 * Returns 429 with Retry-After when the limit is exceeded.
 *
 * Fail-closed (CSV-S-L1): if `osnProfileId` is absent (no upstream auth, or
 * the plugin runs before `osnAuth()`), the request is denied with 429 rather
 * than bucketed under a shared key. This should never fire in practice because
 * the export routes are already gated by `osnAuth()` + `weddingMember()`, but
 * failing closed is the only safe posture (matches `rateLimitMiddleware`'s
 * unresolved-IP behaviour and the wider fail-closed convention in this file).
 */
export function rateLimitMiddlewareByUser(limiter: RateLimiterBackend) {
  return new Elysia().onBeforeHandle({ as: "scoped" }, async (ctx) => {
    const { set } = ctx;
    const { osnProfileId } = ctx as unknown as { osnProfileId?: string };

    if (!osnProfileId) {
      // Fail-closed: absent osnProfileId means upstream osnAuth did not run
      // (or a remount dropped it). This branch is unreachable in normal flow —
      // osnAuth's own onBeforeHandle 401s first — so return 401 (an auth-absence
      // signal), not 429, to keep the defense-in-depth path unambiguous for ops.
      set.status = 401;
      return { error: "unauthorised" };
    }

    const allowed = await limiter.check(osnProfileId);

    if (!allowed) {
      set.status = 429;
      set.headers["retry-after"] = "60";
      return { error: "Too many requests" };
    }
  });
}
