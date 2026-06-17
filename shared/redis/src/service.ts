/**
 * Effect-based Redis service for lifecycle management.
 *
 * - `RedisMemoryLive` — in-memory fallback for dev/test (no Redis server)
 *
 * The ioredis-backed `RedisLive` layer lives in `./ioredis` (re-exported from
 * the `@shared/redis/ioredis` subpath) so this module — and the top-level
 * `@shared/redis` entry — stay free of any static `ioredis` import and remain
 * loadable on Cloudflare Workers.
 */

import { Context, Effect, Layer } from "effect";

import type { RedisClient } from "./client";
import { createMemoryClient } from "./client";

export interface RedisService {
  readonly client: RedisClient;
}

export class Redis extends Context.Tag("@shared/redis/Redis")<Redis, RedisService>() {}

/** Redact credentials from Redis URLs in error messages (S-M3). */
function sanitizeCause(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return msg.replace(/rediss?:\/\/[^@\s]*@/g, (match) => {
    const scheme = match.startsWith("rediss") ? "rediss://" : "redis://";
    return `${scheme}[REDACTED]@`;
  });
}

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
