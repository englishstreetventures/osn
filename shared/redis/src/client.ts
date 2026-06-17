/**
 * RedisClient interface — the subset of Redis operations used by @shared/redis.
 *
 * Implementations (each in its own module so this entry pulls in no backend):
 * - `wrapIoRedis(client)` / `createClientFromUrl(url)` — ioredis, in `./ioredis`
 *   (Node-only; exposed via the `@shared/redis/ioredis` subpath).
 * - `wrapUpstash(redis)` / `createUpstashClient(opts)` — `@upstash/redis` HTTP
 *   REST, in `./upstash` (Workers-compatible).
 * - `createMemoryClient()` — in-memory fallback for dev/test, below.
 */

import { RATE_LIMIT_SCRIPT } from "./rate-limiter";

/**
 * Backend-agnostic Redis client contract. Node/Bun production uses ioredis via
 * `wrapIoRedis()`; Workers uses `wrapUpstash()`; dev/test uses
 * `createMemoryClient()`.
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

const DEFAULT_MAX_ENTRIES = 10_000;

function isExpired(entry: { expiresAt?: number }): boolean {
  return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
}

/**
 * Registry of additional "atomic counter" Lua scripts the in-memory `eval` is
 * allowed to emulate (INCR + PEXPIRE-on-first, returning the new count).
 *
 * X5 keeps `eval` from silently applying rate-limit semantics to an unknown
 * script, but the codebase legitimately has more than one counter script (e.g.
 * the recovery-lockout store). Rather than coupling `@shared/redis` to those
 * call sites' script bodies, each owner registers its script here at module
 * load. Truly unrecognised scripts still fail loud.
 */
const counterScripts = new Set<string>();

/**
 * Register a Lua script with INCR + PEXPIRE-on-first + return-new-count
 * semantics so the in-memory backend can emulate it. No-op against a real
 * Redis (which executes the actual Lua). Call once at module load.
 */
export function registerMemoryCounterScript(script: string): void {
  counterScripts.add(script);
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
    async eval(script, keys, args) {
      // X5: this in-memory eval does not interpret arbitrary Lua. It emulates
      // the fixed-window rate-limit script and any registered counter script
      // (INCR + PEXPIRE-on-first). A truly unrecognised script fails loud
      // instead of silently inheriting counter semantics and returning a wrong
      // answer.
      const isRateLimit = script === RATE_LIMIT_SCRIPT;
      if (!isRateLimit && !counterScripts.has(script)) {
        throw new Error(
          "createMemoryClient.eval only supports RATE_LIMIT_SCRIPT and registered counter " +
            "scripts (see registerMemoryCounterScript); got an unrecognised script. The " +
            "in-memory backend cannot execute arbitrary Lua.",
        );
      }
      // KEYS[1] = key. Rate-limit: ARGV = [maxRequests, windowMs], returns 1/0
      // (allowed flag). Counter: ARGV = [pexpireMs], returns the new count.
      const key = keys[0]!;
      const windowMs = isRateLimit ? Number(args[1]) : Number(args[0]);
      const now = Date.now();

      sweep(windowMs);

      const entry = store.get(key);
      if (!entry || isExpired(entry)) {
        store.set(key, { value: "1", expiresAt: now + windowMs });
        return 1;
      }
      const current = Number(entry.value) + 1;
      entry.value = String(current);
      if (!isRateLimit) return current;
      const maxRequests = Number(args[0]);
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
