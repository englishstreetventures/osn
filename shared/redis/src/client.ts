/**
 * RedisClient interface — the subset of Redis operations used by @shared/redis.
 *
 * Two implementations:
 * - `wrapIoRedis(client)` adapts an ioredis instance for production
 * - `createMemoryClient()` provides an in-memory fallback for dev/test
 */

import { createHash } from "node:crypto";
import IORedis from "ioredis";

/**
 * Backend-agnostic Redis client contract. Production uses ioredis via
 * `wrapIoRedis()`; dev/test uses `createMemoryClient()`.
 */
export interface RedisClient {
  /** EVAL a Lua script atomically. */
  eval(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown>;
  /** PING health check — returns "PONG". */
  ping(): Promise<string>;
  /** GET a string value by key. */
  get(key: string): Promise<string | null>;
  /** SET a string value with optional PX millisecond expiry. */
  set(key: string, value: string, pxMs?: number): Promise<void>;
  /** DEL one or more keys. Returns count of keys removed. */
  del(...keys: string[]): Promise<number>;
  /** Gracefully close the connection. */
  quit(): Promise<void>;
}

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

const DEFAULT_MAX_ENTRIES = 10_000;

function isExpired(entry: { expiresAt?: number }): boolean {
  return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
}

/**
 * In-memory RedisClient for dev/test — no external Redis server needed.
 *
 * Uses a single `Map` store to mirror Redis's unified keyspace. The `eval`
 * method implements the fixed-window rate limit Lua script semantics
 * (INCR + PEXPIRE) so `createRedisRateLimiter` works identically against
 * both the real and in-memory backends.
 *
 * Includes a proactive sweep (P-W2) that evicts expired entries when the
 * store exceeds `maxEntries`, mirroring the pattern in
 * `osn/core/src/lib/rate-limit.ts`.
 */
export function createMemoryClient(maxEntries = DEFAULT_MAX_ENTRIES): RedisClient {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  let lastSweep = Date.now();

  function sweep(windowMs: number) {
    const now = Date.now();
    if (store.size <= maxEntries && now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, entry] of store) {
      if (isExpired(entry)) store.delete(key);
    }
  }

  return {
    async eval(_script, keys, args) {
      // Fixed-window rate limit: KEYS[1] = key, ARGV[1] = maxRequests, ARGV[2] = windowMs
      const key = keys[0]!;
      const maxRequests = Number(args[0]);
      const windowMs = Number(args[1]);
      const now = Date.now();

      sweep(windowMs);

      const entry = store.get(key);
      if (!entry || isExpired(entry)) {
        store.set(key, { value: "1", expiresAt: now + windowMs });
        return 1;
      }
      const current = Number(entry.value) + 1;
      entry.value = String(current);
      return current <= maxRequests ? 1 : 0;
    },
    async ping() {
      return "PONG";
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (isExpired(entry)) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, pxMs) {
      store.set(key, {
        value,
        expiresAt: pxMs !== undefined ? Date.now() + pxMs : undefined,
      });
    },
    async del(...keys) {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return count;
    },
    async quit() {
      store.clear();
    },
  };
}
