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
 * - `get(key)` → `toRedisString(await redis.get(key), "GET")`. The client MUST
 *   be constructed with `automaticDeserialization: false` so values come back
 *   as raw strings — matching ioredis and the rotated-session-store, which
 *   round-trips opaque `familyId` strings and would break if Upstash
 *   JSON-parsed them. `get`'s own type is generic (`get<TData>`), the same
 *   unchecked-claim shape as `eval`, so the reply is narrowed at this
 *   boundary rather than trusted from the SDK's type.
 *   Subsequent calls for the same script body try `EVALSHA` first and fall
 *   back to a full `EVAL` on `NOSCRIPT` (P-I1) — see the doc comment on
 *   `eval` in {@link wrapUpstash} for why this is safe over HTTP/REST
 *   specifically, where a naive port of the ioredis retry-loop pattern would
 *   double-retry.
 * - `set(key, value, pxMs?)` → `redis.set(key, value, { px })`.
 * - `del(...keys)` → `toRedisInteger(await redis.del(...keys), "DEL")`.
 * - `ping()` → `toRedisString(await redis.ping(), "PING") ?? ""`. PING never
 *   actually replies nil, but the fallback keeps the return type `string`
 *   rather than `string | null` for a case that cannot occur.
 * - `quit()` → no-op: the REST transport is stateless, there is no socket to
 *   close.
 */

import { Redis } from "@upstash/redis";

import { toRedisReply, toRedisString, toRedisInteger, type RedisClient } from "./client";

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
 * claims. The claims are made once, here, and each is justified: `eval` keeps
 * the SDK's own `TData = unknown` default rather than pinning a type — it is
 * an HTTP response body the SDK has only JSON-decoded, not a value anyone has
 * checked against the RESP value space, so {@link wrapUpstash} calls it with
 * no type argument (leaving it `unknown`) and runs the result through
 * {@link toRedisReply} before handing it to a caller. `get` mirrors the same
 * shape (`get<TData = unknown>`) for the same reason: the client is built
 * with `automaticDeserialization: false`, but that is a runtime configuration
 * choice the SDK's own type cannot see, so {@link wrapUpstash} narrows the
 * reply through {@link toRedisString} rather than trusting `TData`.
 *
 * `ping` and `del` stay concretely typed (`Promise<string>` /
 * `Promise<number>`) rather than adopting the same generic escape hatch:
 * `anti-slop/no-unknown-returns` is an error under `src/`, and only `eval`
 * and `get` have a generic default to fall back on — `ping`/`del` would
 * widen to a bare `Promise<unknown>`, which the rule forbids. Each is still
 * narrowed at the call site below ({@link toRedisString}, {@link
 * toRedisInteger}) so an SDK that returns something else is caught, not
 * assumed.
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
  /**
   * Same generic shape as `eval`, for the same reason: the reply is an
   * unvalidated HTTP body until {@link wrapUpstash} narrows it through
   * {@link toRedisReply}.
   *
   * No `scriptLoad` alongside this: a script the server has never seen fails
   * `EVALSHA` with `NOSCRIPT`, and the fallback below is a full `EVAL` —
   * which loads the script as a side effect of running it. A separate
   * `SCRIPT LOAD` would only spend a second round trip to do the same thing
   * `EVAL` already does for free.
   */
  evalsha<TData = unknown>(sha1: string, keys: string[], args: (string | number)[]): Promise<TData>;
  ping(): Promise<string>;
  /**
   * `TData` mirrors `eval`'s generic default for the same reason: the SDK's
   * declared reply type is a caller-supplied claim, not a checked value.
   * {@link wrapUpstash} never supplies it, so this resolves to `unknown` and
   * is narrowed through {@link toRedisString} before a caller sees it.
   */
  get<TData = unknown>(key: string): Promise<TData | null>;
  set(key: string, value: string, opts?: { px: number }): Promise<RedisSetReply>;
  del(...keys: string[]): Promise<number>;
}

/** Compute a script's SHA-1 digest the way Redis identifies it for EVALSHA. */
async function computeSha(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(script));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
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
  // Per-client cache, mirroring `wrapIoRedis`'s `scriptShas` in ./ioredis. No
  // lock around a concurrent first call for the same script: computeSha is a
  // pure function of the script body, so two callers racing here at worst
  // hash the same string twice — wasted work, not a correctness issue.
  const scriptShas = new Map<string, string>();

  return {
    async eval(script, keys, args) {
      // Copied because the SDK takes mutable arrays; both are two elements
      // long and the call behind them is an HTTP round-trip.
      const keysCopy = [...keys];
      const argsCopy = [...args];

      const sha = scriptShas.get(script);

      // First sight of this script body: this adapter has no SHA to try, and
      // there is nothing to gain by computing one up front only to still send
      // the full script — a fresh Upstash REST connection has no notion of
      // "the server already has this loaded" the way a long-lived ioredis TCP
      // connection might. So the first call is always a full EVAL, which
      // loads the script on the server as a side effect; only once that has
      // actually succeeded is the SHA cached for later calls to use.
      if (sha === undefined) {
        const reply = await redis.eval(script, keysCopy, argsCopy);
        scriptShas.set(script, await computeSha(script));
        return toRedisReply(reply);
      }

      // Every later call for this script tries EVALSHA first (P-I1), saving
      // the HTTP body weight of the full script on every request.
      //
      // The retry here is intentionally narrower than ioredis's TCP-level
      // NOSCRIPT handling in ./ioredis: `@upstash/redis`'s own transport
      // already retries a *transport* failure internally (chunk-2X4SLXT7.mjs
      // lines 168–188, honoring `this.retry.attempts`/`backoff`), and a
      // non-2xx REST response is turned into a thrown `UpstashError` whose
      // message is built from the server's own error body (line 203) — or,
      // for the streaming path, from the deserialized `error` field (line
      // 386). NOSCRIPT is a server-side "I don't have this script" answer,
      // not a transport hiccup, so it always surfaces as exactly one thrown
      // error with that text; nothing upstream of this catch would already
      // have retried it. Any other error (bad arguments, a real network
      // failure that exhausted the SDK's own retries) is not this adapter's
      // to paper over, so it propagates unchanged.
      try {
        return toRedisReply(await redis.evalsha(sha, keysCopy, argsCopy));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!/NOSCRIPT/i.test(message)) throw cause;
        // The server evicted the script (e.g. a restart, or a FLUSHALL).
        // Re-send the body, which reloads it for next time.
        return toRedisReply(await redis.eval(script, keysCopy, argsCopy));
      }
    },
    async ping() {
      return toRedisString(await redis.ping(), "PING") ?? "";
    },
    async get(key) {
      return toRedisString(await redis.get(key), "GET");
    },
    async set(key, value, pxMs) {
      await redis.set(key, value, pxMs !== undefined ? { px: pxMs } : undefined);
    },
    async del(...keys) {
      if (keys.length === 0) return 0;
      return toRedisInteger(await redis.del(...keys), "DEL");
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
