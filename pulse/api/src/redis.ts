/**
 * Redis client initialisation for the pulse-api composition root.
 *
 * Mirrors `osn/api/src/redis.ts` so the env-driven backend selection behaves
 * identically across services:
 *
 * - `REDIS_URL` set → connect, verify with a health check, use Redis-backed
 *   rate limiters (shared across processes, survives restarts).
 * - `REDIS_URL` unset → in-memory client (local dev / tests).
 * - Health check fails → fall back to in-memory (or exit if `REDIS_REQUIRED`).
 *
 * Security / perf notes carried over from osn/api:
 * - S-M1: TLS warning when a production URL uses `redis://` not `rediss://`.
 * - S-M2: credential redaction in error logs via `sanitizeCause`.
 * - S-L1: optional `REDIS_REQUIRED` for fail-closed startup.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";
import {
  checkRedisHealth,
  createMemoryClient,
  sanitizeCause,
  type RedisClient,
} from "@shared/redis";
import { createClientFromUrl } from "@shared/redis/ioredis";
import { Effect, type Layer } from "effect";

import {
  createRedisDiscoveryRateLimiter,
  createRedisExposureRateLimiter,
  createRedisShareRateLimiter,
  createRedisWriteRateLimiters,
  type PulseWriteRateLimiters,
} from "./lib/redis-rate-limiters";

/**
 * The full set of rate-limiter backends the Pulse app graph needs (W4): the
 * per-USER write limiters plus the three per-IP limiters on the
 * unauthenticated discover / share / exposure surfaces. Built from a
 * `RedisClient` — Redis-backed when `REDIS_URL` is set, otherwise an in-memory
 * client whose backends degrade to process-local counters with identical
 * semantics.
 */
export interface PulseRateLimiters {
  write: PulseWriteRateLimiters;
  discovery: RateLimiterBackend;
  share: RateLimiterBackend;
  exposure: RateLimiterBackend;
}

/** Build every Pulse rate-limiter backend from a single `RedisClient`. */
export function makeRateLimiters(client: RedisClient): PulseRateLimiters {
  return {
    write: createRedisWriteRateLimiters(client),
    discovery: createRedisDiscoveryRateLimiter(client),
    share: createRedisShareRateLimiter(client),
    exposure: createRedisExposureRateLimiter(client),
  };
}

/**
 * In-memory rate limiters for tests + the no-`REDIS_URL` local path. Backed by
 * `createMemoryClient()` so the same `createRedis*` factories drive both the
 * Redis and in-memory cases — one policy, one set of call sites.
 */
export function makeMemoryRateLimiters(): PulseRateLimiters {
  return makeRateLimiters(createMemoryClient());
}

export interface InitRedisOptions {
  /** `REDIS_URL` env value (or undefined). */
  redisUrl?: string;
  /** When `true`, the process exits instead of falling back to in-memory (S-L1). */
  redisRequired?: boolean;
  /** `NODE_ENV` value — used for the TLS warning (S-M1). */
  nodeEnv?: string;
  /** Effect layer for structured logging. */
  loggerLayer: Layer.Layer<never>;
}

export async function initRedisClient(opts: InitRedisOptions): Promise<RedisClient> {
  const { redisUrl, redisRequired = false, nodeEnv, loggerLayer } = opts;

  if (!redisUrl) {
    void Effect.runPromise(
      Effect.logInfo("REDIS_URL not set — using in-memory rate limiters").pipe(
        Effect.provide(loggerLayer),
      ),
    );
    return createMemoryClient();
  }

  // S-M1: warn when a production connection is unencrypted.
  if (nodeEnv === "production" && !redisUrl.startsWith("rediss://")) {
    await Effect.runPromise(
      Effect.logWarning("REDIS_URL does not use TLS (rediss://) — connection is unencrypted").pipe(
        Effect.provide(loggerLayer),
      ),
    );
  }

  try {
    const client = createClientFromUrl(redisUrl);
    await client.connect();

    const healthy = await checkRedisHealth(client);
    if (!healthy) {
      await client.disconnect();
      throw new Error("Redis startup health check failed");
    }

    void Effect.runPromise(
      Effect.logInfo("Redis connected — using Redis-backed rate limiters").pipe(
        Effect.provide(loggerLayer),
      ),
    );
    return client;
  } catch (cause) {
    const safeMessage = sanitizeCause(cause);

    if (redisRequired) {
      await Effect.runPromise(
        Effect.logError(
          "Redis connection failed and REDIS_REQUIRED is set — aborting startup",
        ).pipe(Effect.annotateLogs({ error: safeMessage }), Effect.provide(loggerLayer)),
      );
      process.exit(1);
    }

    await Effect.runPromise(
      Effect.logWarning(
        "Redis connection failed at startup — falling back to in-memory rate limiters",
      ).pipe(Effect.annotateLogs({ error: safeMessage }), Effect.provide(loggerLayer)),
    );
    return createMemoryClient();
  }
}
