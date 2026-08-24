/**
 * Upstash REST-backed `RedisClient` implementation.
 *
 * `@upstash/redis` speaks the Upstash HTTP/REST API via `fetch`, so it runs on
 * Cloudflare Workers (workerd) where ioredis's raw TCP sockets cannot. This
 * module is the Workers-path counterpart to `./ioredis` and carries no static
 * `ioredis` import, so the top-level `@shared/redis` entry stays Workers-safe.
 *
 * Mapping decisions (see the `RedisClient` contract in `./client`):
 * - `eval(script, keys, args)` → `toRedisReply(await redis.eval(script, keys,
 *   args))`. The SDK types `eval`'s result as whatever the caller claims, but
 *   it is really an HTTP response body nobody has checked — `toRedisReply`
 *   narrows it to the RESP value space at this boundary, the same as the
 *   ioredis path does in `./ioredis`.
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

import { toRedisReply, type RedisClient } from "./client";

/**
 * Redis's reply to SET: the status string `"OK"`, or nil when a conditional
 * SET (NX/XX) declined to write.
 *
 * Widened to `string` rather than the literal `"OK"` because `@upstash/redis`
 * types `set` as `<TData>(key, value: TData, opts?) => Promise<"OK" | TData |
 * null>` — with a `string` value that collapses to `string | null`, and pinning
 * the literal here would stop a real `Redis` instance satisfying
 * {@link UpstashLike}. {@link wrapUpstash} discards the value either way: the
 * `RedisClient` contract makes `set` a `Promise<void>`.
 */
export type RedisSetReply = string | null;

/**
 * Minimal structural view of the `@upstash/redis` client surface this adapter
 * depends on. Declared locally so callers can pass either a real `Redis`
 * instance or a fake in tests without coupling to the SDK's full type.
 *
 * The SDK types most of these as generic in their result (`get<TData>`,
 * `eval<TArgs, TData = unknown>`), i.e. it will hand back whatever the caller
 * claims. The claims are made once, here, and each is justified: `get` returns
 * raw strings because the client is built with `automaticDeserialization:
 * false`. `eval` keeps the SDK's own `TData = unknown` default rather than
 * pinning a type — it is an HTTP response body the SDK has only JSON-decoded,
 * not a value anyone has checked against the RESP value space, so
 * {@link wrapUpstash} calls it with no type argument (leaving it `unknown`)
 * and runs the result through {@link toRedisReply} before handing it to a
 * caller.
 */
export interface UpstashLike {
  /**
   * `keys` / `args` are mutable arrays because that is how `@upstash/redis`
   * types them, and mirroring the SDK is what lets a real `Redis` instance
   * satisfy this interface without a cast. The `RedisClient` contract hands
   * `eval` readonly arrays, so {@link wrapUpstash} copies them on the way in.
   *
   * `TData` mirrors the SDK's own generic (defaulting to `unknown`) rather
   * than a flat `Promise<unknown>` return: {@link wrapUpstash} never supplies
   * it, so the call resolves to `unknown` regardless, and every value still
   * passes through {@link toRedisReply} before a caller sees it.
   */
  eval<TData = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<TData>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { px: number }): Promise<RedisSetReply>;
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
      // Copied because the SDK takes mutable arrays; both are two elements
      // long and the call behind them is an HTTP round-trip. The reply itself
      // is unvalidated JSON off the wire until toRedisReply narrows it — same
      // boundary check the ioredis path applies in ./ioredis.
      return toRedisReply(await redis.eval(script, [...keys], [...args]));
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
  return wrapUpstash(redis);
}
