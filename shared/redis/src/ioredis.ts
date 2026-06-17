/**
 * ioredis-backed `RedisClient` implementation + Effect lifecycle layer.
 *
 * Isolated behind the `@shared/redis/ioredis` subpath so the top-level
 * `@shared/redis` entry stays free of any static `ioredis` import. ioredis
 * depends on Node's `net`/`tls` sockets and cannot run on Cloudflare Workers
 * (workerd) — keeping it in a dedicated module means the Workers bundle (which
 * imports only `@shared/redis` and `@shared/redis/upstash`) never pulls it in,
 * while the Bun/local path imports it explicitly from here.
 */

import { createHash } from "node:crypto";

import { Effect, Layer } from "effect";
import IORedis from "ioredis";

import type { RedisClient } from "./client";
import { RedisError } from "./errors";
import type { RedisService } from "./service";
import { Redis, sanitizeCause } from "./service";

/**
 * Wrap an ioredis instance as a `RedisClient`.
 *
 * Transparently caches Lua script SHAs and uses EVALSHA on subsequent calls
 * to avoid re-transmitting the full script body on every request (P-W1).
 * SHAs are computed eagerly on first sight of each script (P-W2) so the
 * crypto cost is paid once, not on every EVAL fallback.
 * Falls back to EVAL on NOSCRIPT errors (e.g. after a Redis restart).
 */
export function wrapIoRedis(client: IORedis): RedisClient {
  const scriptShas = new Map<string, string>();

  /** Compute + cache SHA-1 on first sight of a script (P-W2). */
  function ensureSha(script: string): string {
    let sha = scriptShas.get(script);
    if (!sha) {
      sha = createHash("sha1").update(script).digest("hex");
      scriptShas.set(script, sha);
    }
    return sha;
  }

  return {
    async eval(script, keys, args) {
      const allArgs: (string | number)[] = [...keys, ...args];
      const sha = ensureSha(script);

      // Always try EVALSHA first — avoids sending full script body (P-W2)
      try {
        return await client.evalsha(sha, keys.length, ...allArgs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("NOSCRIPT")) throw err;
      }

      // NOSCRIPT fallback: full EVAL (first call or after Redis restart)
      return await client.eval(script, keys.length, ...allArgs);
    },
    async ping() {
      return client.ping();
    },
    async get(key) {
      return client.get(key);
    },
    async set(key, value, pxMs) {
      if (pxMs !== undefined) {
        await client.set(key, value, "PX", pxMs);
      } else {
        await client.set(key, value);
      }
    },
    async del(...keys) {
      if (keys.length === 0) return 0;
      return client.del(...keys);
    },
    async quit() {
      await client.quit();
    },
  };
}

/**
 * Extended client returned by `createClientFromUrl` with explicit lifecycle
 * methods for startup and teardown (S-L2 / P-W1).
 */
export interface ConnectableRedisClient extends RedisClient {
  /** Explicitly open the TCP connection. Required because `lazyConnect` is used. */
  connect(): Promise<void>;
  /**
   * Forcibly tear down the connection and stop the ioredis retry loop.
   * Use this instead of `quit()` when the connection was never fully
   * established (e.g. health check failure at startup).
   */
  disconnect(): Promise<void>;
}

/**
 * Create a `RedisClient` from a URL with safe connection defaults (S-L2 / P-W1):
 *
 * - `lazyConnect: true` — prevents background connection before the caller is
 *   ready. Call `.connect()` explicitly before use.
 * - `connectTimeout: 5_000` — bounds the TCP handshake so a firewalled port
 *   doesn't hang indefinitely.
 * - `maxRetriesPerRequest: 1` — prevents a single command from retrying
 *   internally for an unbounded period.
 *
 * The returned `ConnectableRedisClient` extends `RedisClient` with `connect()`
 * and `disconnect()` for explicit lifecycle management.
 */
export function createClientFromUrl(url: string): ConnectableRedisClient {
  const raw = new IORedis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
  });
  const client = wrapIoRedis(raw);

  return {
    ...client,
    async connect() {
      await raw.connect();
    },
    async disconnect() {
      raw.disconnect(false);
    },
  };
}

const STARTUP_PING_TIMEOUT_MS = 5_000;

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

    return { client } satisfies RedisService;
  }),
);
