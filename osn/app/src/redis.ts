/**
 * Redis client initialisation for the osn-app composition root.
 *
 * Extracted from `index.ts` so the three startup branches (no-URL, healthy,
 * fallback) are independently testable.
 *
 * Security / performance considerations addressed here:
 * - S-M1: TLS warning when production URL uses `redis://` instead of `rediss://`
 * - S-M2: Credential redaction in error logs via `sanitizeCause`
 * - S-L1: Optional `REDIS_REQUIRED` env var for fail-closed startup
 * - S-L2 / P-W1: `lazyConnect` + explicit `connect()` / `disconnect()` lifecycle
 * - P-I2: Warning-level logs are `await`-ed, not fire-and-forget
 */

import {
  createMemoryClient,
  createClientFromUrl,
  checkRedisHealth,
  sanitizeCause,
  type RedisClient,
} from "@shared/redis";
import { Effect, type Layer } from "effect";

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

/**
 * Initialise the Redis client with env-driven backend selection.
 *
 * - `REDIS_URL` set → connect to Redis; verify with health check
 * - `REDIS_URL` unset → in-memory client (local dev)
 * - Health check fails → fall back to in-memory (or exit if `REDIS_REQUIRED`)
 */
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

  // S-M1: warn when production connection is unencrypted
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
    // S-M2: redact credentials from error messages before logging
    const safeMessage = sanitizeCause(cause);

    // S-L1: fail-closed when REDIS_REQUIRED is set
    if (redisRequired) {
      await Effect.runPromise(
        Effect.logError(
          "Redis connection failed and REDIS_REQUIRED is set — aborting startup",
        ).pipe(Effect.annotateLogs({ error: safeMessage }), Effect.provide(loggerLayer)),
      );
      process.exit(1);
    }

    // P-I2: await the warning log so observability bootstrap failures surface
    await Effect.runPromise(
      Effect.logWarning(
        "Redis connection failed at startup — falling back to in-memory rate limiters",
      ).pipe(Effect.annotateLogs({ error: safeMessage }), Effect.provide(loggerLayer)),
    );
    return createMemoryClient();
  }
}
