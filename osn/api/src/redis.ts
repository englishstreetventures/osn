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
  createUpstashClient,
  checkRedisHealth,
  sanitizeCause,
  type RedisClient,
} from "@shared/redis";
// ioredis is imported from the dedicated subpath so the Workers selector
// (`initRedisClientFromEnv`, below) can be bundled without dragging ioredis —
// which needs Node `net`/`tls` sockets — into the workerd bundle.
import { createClientFromUrl } from "@shared/redis/ioredis";
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

/**
 * Subset of the Workers `env` binding object this selector reads. Provided as a
 * loose record so the Phase-6 Workers entry can hand its generated `Env` type
 * straight through without a structural mismatch.
 */
export interface RedisEnv {
  readonly UPSTASH_REDIS_REST_URL?: string;
  readonly UPSTASH_REDIS_REST_TOKEN?: string;
}

/**
 * Workers-path Redis selector — synchronous, ioredis-free, side-effect-free.
 *
 * Unlike {@link initRedisClient} (the Bun composition root), this performs NO
 * startup health check, has NO `REDIS_REQUIRED` fail-closed mode, and never
 * calls `process.exit` — none of which apply on workerd, where there is no
 * long-lived process to guard and Upstash's REST transport is stateless (the
 * first real command surfaces any connectivity problem). It simply chooses a
 * backend from the request-scoped `env` bindings:
 *
 * - both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set →
 *   {@link createUpstashClient} (HTTP/REST, Workers-compatible).
 * - otherwise → {@link createMemoryClient} (e.g. `wrangler dev` without
 *   Upstash bindings).
 *
 * Wired into the Workers entry in Phase 6; unit-tested standalone for now.
 */
export function initRedisClientFromEnv(env: RedisEnv): RedisClient {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return createUpstashClient({ url, token });
  }
  return createMemoryClient();
}
