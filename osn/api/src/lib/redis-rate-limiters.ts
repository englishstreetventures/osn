/**
 * Redis-backed rate limiter factories for auth and graph routes.
 *
 * These mirror the in-memory defaults in `createDefaultAuthRateLimiters()` and
 * `createDefaultGraphRateLimiter()` but delegate to `createRedisRateLimiter`
 * from `@shared/redis`, which uses an atomic Lua script (INCR + PEXPIRE) for
 * correct fixed-window counting across processes.
 *
 * The returned objects satisfy `RateLimiterBackend` from `./rate-limit.ts` —
 * `check(key)` returns `Promise<boolean>`, which the existing `await`-based
 * call sites in auth.ts / graph.ts handle transparently.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";
import { createRedisRateLimiter } from "@shared/redis";
import type { RedisClient } from "@shared/redis";

import type { AuthRateLimiters } from "../routes/auth";
import type { ProfileRateLimiters } from "../routes/profile";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;

/**
 * Build all 13 auth rate limiters backed by a shared Redis client.
 * Namespace convention: `auth:{endpoint_name}` — produces Redis keys like
 * `rl:auth:register_begin:192.168.1.1`.
 */
export function createRedisAuthRateLimiters(client: RedisClient): AuthRateLimiters {
  const rl = (namespace: string, maxRequests: number): RateLimiterBackend =>
    createRedisRateLimiter(client, { namespace, maxRequests, windowMs: ONE_MINUTE_MS });

  return {
    registerBegin: rl("auth:register_begin", 5),
    registerComplete: rl("auth:register_complete", 10),
    handleCheck: rl("auth:handle_check", 10),
    otpBegin: rl("auth:otp_begin", 5),
    otpComplete: rl("auth:otp_complete", 10),
    magicBegin: rl("auth:magic_begin", 5),
    magicVerify: rl("auth:magic_verify", 10),
    passkeyLoginBegin: rl("auth:passkey_login_begin", 10),
    passkeyLoginComplete: rl("auth:passkey_login_complete", 10),
    passkeyRegisterBegin: rl("auth:passkey_register_begin", 10),
    passkeyRegisterComplete: rl("auth:passkey_register_complete", 10),
    profileSwitch: rl("auth:profile_switch", 10),
    profileList: rl("auth:profile_list", 10),
    recoveryGenerate: createRedisRateLimiter(client, {
      namespace: "auth:recovery_generate",
      maxRequests: 1,
      windowMs: 24 * ONE_HOUR_MS,
    }),
    recoveryComplete: createRedisRateLimiter(client, {
      namespace: "auth:recovery_complete",
      maxRequests: 5,
      windowMs: ONE_HOUR_MS,
    }),
  };
}

/**
 * Build the graph write rate limiter backed by Redis.
 * Namespace: `graph:write` — key is the authenticated user ID.
 */
export function createRedisGraphRateLimiter(client: RedisClient): RateLimiterBackend {
  return createRedisRateLimiter(client, {
    namespace: "graph:write",
    maxRequests: 60,
    windowMs: ONE_MINUTE_MS,
  });
}

/**
 * Build the organisation write rate limiter backed by Redis.
 * Namespace: `org:write` — key is the authenticated user ID.
 */
export function createRedisOrgRateLimiter(client: RedisClient): RateLimiterBackend {
  return createRedisRateLimiter(client, {
    namespace: "org:write",
    maxRequests: 60,
    windowMs: ONE_MINUTE_MS,
  });
}

/**
 * Build the recommendations rate limiter backed by Redis.
 * Namespace: `recs:read` — key is the authenticated user ID.
 *
 * Tighter budget than graph/org writes because each request runs an
 * expensive FOF fan-out.
 */
export function createRedisRecommendationRateLimiter(client: RedisClient): RateLimiterBackend {
  return createRedisRateLimiter(client, {
    namespace: "recs:read",
    maxRequests: 20,
    windowMs: ONE_MINUTE_MS,
  });
}

/**
 * Build all 3 profile CRUD rate limiters backed by a shared Redis client.
 * Namespace convention: `profile:{action}`.
 */
export function createRedisProfileRateLimiters(client: RedisClient): ProfileRateLimiters {
  const rl = (namespace: string, maxRequests: number): RateLimiterBackend =>
    createRedisRateLimiter(client, { namespace, maxRequests, windowMs: ONE_MINUTE_MS });

  return {
    profileCreate: rl("profile:create", 5),
    profileDelete: rl("profile:delete", 5),
    profileSetDefault: rl("profile:set_default", 10),
  };
}
