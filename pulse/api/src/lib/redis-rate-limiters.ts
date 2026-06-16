/**
 * Redis-backed rate limiter factories for the Pulse API.
 *
 * Mirrors `osn/api/src/lib/redis-rate-limiters.ts`: each factory delegates to
 * `createRedisRateLimiter` from `@shared/redis`, which uses an atomic Lua
 * script (INCR + PEXPIRE) for correct fixed-window counting across processes.
 *
 * The returned objects satisfy `RateLimiterBackend` from `@shared/rate-limit`
 * — `check(key)` returns `Promise<boolean>`, which the existing `await`-based
 * call sites (discovery limiter + the per-user write helper) handle
 * transparently. Limits are kept byte-for-byte in step with the in-memory
 * defaults in `./rate-limit.ts` (`PULSE_WRITE_LIMITS`) so the only thing that
 * changes between local and production is the backing store, never the policy.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";
import { createRedisRateLimiter, type RedisClient } from "@shared/redis";

import type { PulseWriteEndpoint } from "../metrics";
import { PULSE_WRITE_LIMITS } from "./rate-limit";

const ONE_MINUTE_MS = 60_000;

/**
 * Per-user write limiters, one Redis namespace per endpoint. Keys look like
 * `rl:pulse:write:event_create:usr_alice`. Limits come from the single source
 * of truth in `PULSE_WRITE_LIMITS`.
 */
export type PulseWriteRateLimiters = Readonly<Record<PulseWriteEndpoint, RateLimiterBackend>>;

export function createRedisWriteRateLimiters(client: RedisClient): PulseWriteRateLimiters {
  const build = (endpoint: PulseWriteEndpoint): RateLimiterBackend =>
    createRedisRateLimiter(client, {
      namespace: `pulse:write:${endpoint}`,
      ...PULSE_WRITE_LIMITS[endpoint],
    });

  return {
    event_create: build("event_create"),
    event_update: build("event_update"),
    rsvp_upsert: build("rsvp_upsert"),
    event_invite: build("event_invite"),
    comms_blast: build("comms_blast"),
    series_create: build("series_create"),
    series_update: build("series_update"),
    close_friend_mutate: build("close_friend_mutate"),
  };
}

/**
 * Per-IP limiter for the unauthenticated `GET /events/discover` read.
 * Namespace `pulse:discover` — key is the client IP. Matches the 60/min
 * in-memory default (`createDefaultDiscoveryRateLimiter`).
 */
export function createRedisDiscoveryRateLimiter(client: RedisClient): RateLimiterBackend {
  return createRedisRateLimiter(client, {
    namespace: "pulse:discover",
    maxRequests: 60,
    windowMs: ONE_MINUTE_MS,
  });
}
