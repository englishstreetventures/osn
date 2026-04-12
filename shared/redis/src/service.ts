/**
 * Effect-based Redis service for lifecycle management.
 *
 * - `RedisLive` — connects via REDIS_URL; Layer.scoped finalizer calls quit()
 * - `RedisMemoryLive` — in-memory fallback for dev/test (no Redis server)
 */

import { Context, Effect, Layer } from "effect";
import IORedis from "ioredis";

import type { RedisClient } from "./client";
import { wrapIoRedis, createMemoryClient } from "./client";
import { RedisError } from "./errors";

export interface RedisService {
  readonly client: RedisClient;
}

export class Redis extends Context.Tag("@shared/redis/Redis")<Redis, RedisService>() {}

const STARTUP_PING_TIMEOUT_MS = 5_000;

/** Redact credentials from Redis URLs in error messages (S-M3). */
function sanitizeCause(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return msg.replace(/rediss?:\/\/[^@\s]*@/g, (match) => {
    const scheme = match.startsWith("rediss") ? "rediss://" : "redis://";
    return `${scheme}[REDACTED]@`;
  });
}

/**
 * Live layer — connects to `REDIS_URL`. `Layer.scoped` ensures `quit()` on
 * shutdown. Fails with `RedisError` if `REDIS_URL` is unset or the connection
 * cannot be verified via PING.
 */
export const RedisLive: Layer.Layer<Redis, RedisError> = Layer.scoped(
  Redis,
  Effect.gen(function* () {
    const url = process.env.REDIS_URL;
    if (!url) {
      return yield* Effect.fail(
        new RedisError({ cause: "REDIS_URL environment variable is not set" }),
      );
    }

    // S-M1: warn when production connection is unencrypted
    if (!url.startsWith("rediss://") && process.env.NODE_ENV === "production") {
      yield* Effect.logWarning(
        "REDIS_URL does not use TLS (rediss://) — connection is unencrypted",
      );
    }

    const raw = new IORedis(url);
    const client = wrapIoRedis(raw);

    // P-I2: startup ping with timeout to prevent indefinite hangs
    let timer: ReturnType<typeof setTimeout>;
    yield* Effect.tryPromise({
      try: () =>
        Promise.race([
          client.ping().finally(() => clearTimeout(timer)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Redis startup ping timed out")),
              STARTUP_PING_TIMEOUT_MS,
            );
          }),
        ]),
      catch: (cause) => new RedisError({ cause: sanitizeCause(cause) }),
    }).pipe(Effect.tapError(() => Effect.logError("Redis connection failed")));

    yield* Effect.addFinalizer(() => Effect.promise(() => client.quit().catch(() => {})));

    return { client };
  }),
);

/**
 * In-memory layer for dev/test — no Redis server required.
 * Provides the same `Redis` service tag backed by an in-memory client.
 */
export const RedisMemoryLive: Layer.Layer<Redis> = Layer.scoped(
  Redis,
  Effect.gen(function* () {
    const client = createMemoryClient();

    yield* Effect.addFinalizer(() => Effect.promise(() => client.quit()));

    return { client };
  }),
);

export { sanitizeCause };
