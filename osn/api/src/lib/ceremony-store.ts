/**
 * Generic Redis-backed store for short-lived ceremony / pending-state entries
 * (O3).
 *
 * Every passkey/login challenge, pending registration, step-up OTP, pending
 * email change and cross-device request used to live in a module-level `Map`
 * inside `auth.ts`. That is correct for single-process dev but silently
 * partitions in multi-pod deployments: a `begin` served by pod A writes the
 * challenge to A's heap, and the matching `complete` routed to pod B finds
 * nothing. The user sees a spurious "challenge expired", and — worse for the
 * caps — a per-account rate window enforced only within one pod is trivially
 * bypassed by spreading requests across pods.
 *
 * This module provides the same injectable triple-pattern used by
 * `StepUpJtiStore` and `RotatedSessionStore`:
 *
 *   - `CeremonyStore<V>` — the interface stored on `AuthConfig`.
 *   - `createInMemoryCeremonyStore()` — the single-process default, a TTL-swept
 *     bounded `Map` (port of the old inline behaviour, including the
 *     opportunistic sweep + hard size cap).
 *   - `createRedisCeremonyStore(client, …)` — the multi-pod implementation,
 *     backed by `RedisClient` GET/SET-with-PX/DEL so entry expiry is delegated
 *     to Redis's native per-key TTL (no background sweeper, no unbounded
 *     growth).
 *
 * Values are arbitrary JSON-serialisable objects (challenge strings, OTP
 * hashes, pending-registration payloads, …). The `attempts` counter that some
 * in-memory stores carried per entry is just another field on the stored value
 * — `getAndIncrementAttempts` / `replace` keep that semantics intact across
 * both backends.
 *
 * Fail-open vs fail-closed posture is documented per call site in `auth.ts`.
 * The Redis backend itself surfaces errors via the `onError` hook and returns
 * a conservative result (`get` → `null`, `set`/`delete` → swallow) so a Redis
 * blip degrades to "challenge not found / re-begin" rather than a 500.
 */

import type { RedisClient, RedisNamespace } from "@shared/redis";

export type CeremonyStoreBackend = "memory" | "redis";

/** Outcome hook for observability — wired to the metric layer in `auth.ts`. */
export interface CeremonyStoreObserver {
  onOp?: (op: "set" | "get" | "delete", namespace: RedisNamespace) => void;
  /** +1 on insert of a new key, -1 on delete of an existing key. */
  onEntryDelta?: (delta: number, namespace: RedisNamespace) => void;
  /** Redis backend only — caught command error. */
  onError?: (op: "set" | "get" | "delete", cause: unknown) => void;
}

export interface CeremonyStore<V> {
  readonly backend: CeremonyStoreBackend;
  readonly namespace: RedisNamespace;
  /** Store `value` under `key` with a `ttlMs` expiry. Overwrites any prior value. */
  set(key: string, value: V, ttlMs: number): Promise<void>;
  /** Fetch the live value for `key`, or `null` if absent/expired. */
  get(key: string): Promise<V | null>;
  /** Remove `key`. Idempotent. */
  delete(key: string): Promise<void>;
}

/** Hard ceiling on in-memory entries per store — belt to the TTL-sweep braces. */
export const CEREMONY_STORE_MAX = 10_000;

interface MemoryEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * In-memory ceremony store — single-process dev/test. Mirrors the old inline
 * `Map` behaviour: an opportunistic sweep on every `set` evicts expired
 * entries, and a FIFO drop keeps the map bounded under abuse even if every
 * entry is still live.
 */
export function createInMemoryCeremonyStore<V>(
  namespace: RedisNamespace,
  observer: CeremonyStoreObserver = {},
): CeremonyStore<V> {
  const entries = new Map<string, MemoryEntry<V>>();

  function sweep(): void {
    const nowMs = Date.now();
    for (const [k, entry] of entries) {
      if (entry.expiresAt <= nowMs) {
        entries.delete(k);
        observer.onEntryDelta?.(-1, namespace);
      }
    }
    // Bound: drop oldest insertions (Map preserves insertion order) until
    // back under the cap. Rare — the TTL sweep above handles the common case.
    while (entries.size > CEREMONY_STORE_MAX) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
      observer.onEntryDelta?.(-1, namespace);
    }
  }

  return {
    backend: "memory",
    namespace,
    async set(key, value, ttlMs) {
      sweep();
      const existed = entries.has(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      observer.onOp?.("set", namespace);
      if (!existed) observer.onEntryDelta?.(1, namespace);
    },
    async get(key) {
      observer.onOp?.("get", namespace);
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        observer.onEntryDelta?.(-1, namespace);
        return null;
      }
      return entry.value;
    },
    async delete(key) {
      observer.onOp?.("delete", namespace);
      if (entries.delete(key)) observer.onEntryDelta?.(-1, namespace);
    },
  };
}

export interface RedisCeremonyStoreConfig {
  observer?: CeremonyStoreObserver;
  /** Override the key prefix. Defaults to `osn:ceremony:{namespace}`. */
  keyPrefix?: string;
}

function redisKey(prefix: string, key: string): string {
  return `${prefix}:${key}`;
}

/**
 * Redis-backed ceremony store. One key per entry: `{prefix}:{key}` → JSON,
 * PX = ttlMs. Expiry is native, so there is no sweeper and no size bound to
 * maintain. `get` JSON-parses; a malformed/partial value (should never happen
 * — we are the only writer) is treated as absent.
 *
 * Errors are swallowed conservatively and surfaced via `observer.onError`:
 *   - `get` → `null` (caller re-begins the ceremony)
 *   - `set` / `delete` → no-op (the ceremony will fail closed at `complete`
 *     because the value was never persisted)
 */
export function createRedisCeremonyStore<V>(
  client: RedisClient,
  namespace: RedisNamespace,
  config: RedisCeremonyStoreConfig = {},
): CeremonyStore<V> {
  const observer = config.observer ?? {};
  const prefix = config.keyPrefix ?? `osn:ceremony:${namespace}`;

  // Shield the store from a throwing observer callback (e.g. a logger wired to
  // Effect.runPromise that itself throws on misconfiguration). A crash in the
  // hook must not cascade into a rejected store op.
  const safeError = (op: "set" | "get" | "delete", cause: unknown): void => {
    try {
      observer.onError?.(op, cause);
    } catch {
      /* swallowed */
    }
  };

  return {
    backend: "redis",
    namespace,
    async set(key, value, ttlMs) {
      observer.onOp?.("set", namespace);
      try {
        await client.set(redisKey(prefix, key), JSON.stringify(value), ttlMs);
        observer.onEntryDelta?.(1, namespace);
      } catch (cause) {
        safeError("set", cause);
      }
    },
    async get(key) {
      observer.onOp?.("get", namespace);
      try {
        const raw = await client.get(redisKey(prefix, key));
        if (raw === null) return null;
        return JSON.parse(raw) as V;
      } catch (cause) {
        safeError("get", cause);
        return null;
      }
    },
    async delete(key) {
      observer.onOp?.("delete", namespace);
      try {
        const removed = await client.del(redisKey(prefix, key));
        if (removed > 0) observer.onEntryDelta?.(-1, namespace);
      } catch (cause) {
        safeError("delete", cause);
      }
    },
  };
}
