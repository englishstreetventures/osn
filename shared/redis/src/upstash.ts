/**
 * Upstash REST-backed `RedisClient` implementation.
 *
 * `@upstash/redis` speaks the Upstash HTTP/REST API via `fetch`, so it runs on
 * Cloudflare Workers (workerd) where ioredis's raw TCP sockets cannot. This
 * module is the Workers-path counterpart to `./ioredis` and carries no static
 * `ioredis` import, so the top-level `@shared/redis` entry stays Workers-safe.
 *
 * Mapping decisions (see the `RedisClient` contract in `./client`):
 * - `eval(script, keys, args)` → `redis.eval(script, keys, args)`. Upstash
 *   returns the Lua script's value directly (numeric for the rate-limit script
 *   and the recovery-lockout counter; the step-up jti check accepts `1` or
 *   `"1"`), so no shaping is needed.
 * - `get(key)` → `redis.get(key)`. The client MUST be constructed with
 *   `automaticDeserialization: false` so values come back as raw strings —
 *   matching ioredis and the rotated-session-store, which round-trips opaque
 *   `familyId` strings and would break if Upstash JSON-parsed them.
 * - `set(key, value, pxMs?)` → `redis.set(key, value, { px })`.
 * - `del(...keys)` → `redis.del(...keys)` (returns the count removed).
 * - `ping()` → `redis.ping()`.
 * - `quit()` → no-op: the REST transport is stateless, there is no socket to
 *   close.
 */

import { Redis } from "@upstash/redis";

import type { RedisClient } from "./client";

/**
 * Minimal structural view of the `@upstash/redis` client surface this adapter
 * depends on. Declared locally so callers can pass either a real `Redis`
 * instance or a fake in tests without coupling to the SDK's full type.
 */
export interface UpstashLike {
  eval(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { px: number }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Adapt an `@upstash/redis` client (or structural equivalent) as a
 * `RedisClient`.
 *
 * NOTE: the passed client must have been constructed with
 * `automaticDeserialization: false` (see {@link createUpstashClient}) so `get`
 * returns raw strings rather than JSON-parsed values.
 */
export function wrapUpstash(redis: UpstashLike): RedisClient {
  return {
    async eval(script, keys, args) {
      return redis.eval(script, keys, args);
    },
    async ping() {
      return redis.ping();
    },
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, pxMs) {
      await redis.set(key, value, pxMs !== undefined ? { px: pxMs } : undefined);
    },
    async del(...keys) {
      if (keys.length === 0) return 0;
      return redis.del(...keys);
    },
    async quit() {
      // Stateless HTTP/REST transport — nothing to tear down.
    },
  };
}

/** Connection inputs for {@link createUpstashClient}. */
export interface UpstashClientConfig {
  /** `UPSTASH_REDIS_REST_URL`. */
  readonly url: string;
  /** `UPSTASH_REDIS_REST_TOKEN`. */
  readonly token: string;
}

/**
 * Create a Workers-compatible `RedisClient` backed by Upstash's HTTP/REST API.
 *
 * `automaticDeserialization: false` is non-negotiable: the rest of the codebase
 * stores and reads opaque strings (session family ids, counters) and relies on
 * `get` returning exactly what `set` wrote, byte-for-byte, the same as ioredis.
 */
export function createUpstashClient(config: UpstashClientConfig): RedisClient {
  const redis = new Redis({
    url: config.url,
    token: config.token,
    automaticDeserialization: false,
  });
  return wrapUpstash(redis as unknown as UpstashLike);
}
