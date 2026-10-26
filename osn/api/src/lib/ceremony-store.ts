/**
 * Store for short-lived ceremony / pending-state entries: passkey and login
 * challenges, pending registrations, step-up and recovery codes, pending email
 * changes, cross-device requests, parked `/authorize` requests.
 *
 * A `begin` and its `complete` can land on different isolates, so a deployed
 * Worker keeps these on the `COORDINATION` Durable Object
 * (`createDurableCeremonyStore` in `lib/coordination/durable.ts`); a `begin`
 * kept in one isolate's memory would be invisible to the next.
 *
 *   - `CeremonyStore<V>` — the interface stored on `AuthConfig`.
 *   - `createInMemoryCeremonyStore()` — the single-process store for the Bun
 *     dev server and tests: a TTL-swept bounded `Map`, with an opportunistic
 *     sweep and a hard size cap.
 *
 * Values are JSON-serialisable objects (challenge strings, OTP hashes,
 * pending-registration payloads, …). An `attempts` counter some entries carry
 * is just another field on the stored value.
 *
 * A backend error propagates from every operation; the call site decides what
 * the request answers.
 */

import type { CeremonyStoreName } from "./coordination/names";

export type CeremonyStoreBackend = "memory" | "durable_object";

/** Outcome hook for observability — wired to the metric layer in `stores.ts`. */
export interface CeremonyStoreObserver {
  onOp?: (op: "set" | "get" | "delete", namespace: CeremonyStoreName) => void;
  /** +1 on insert of a new key, -1 on delete of an existing key. */
  onEntryDelta?: (delta: number, namespace: CeremonyStoreName) => void;
}

export interface CeremonyStore<V> {
  readonly backend: CeremonyStoreBackend;
  readonly namespace: CeremonyStoreName;
  /** Store `value` under `key` with a `ttlMs` expiry. Overwrites any prior value. */
  set(key: string, value: V, ttlMs: number): Promise<void>;
  /** Fetch the live value for `key`, or `null` if absent/expired. */
  get(key: string): Promise<V | null>;
  /** Remove `key`. Idempotent. */
  delete(key: string): Promise<void>;
  /**
   * Claim `key` for single use: remove it and report whether THIS call is the
   * one that removed a live entry. First consumer wins; every other caller
   * gets `false`, including one racing in another isolate.
   *
   * The same guarantee `StepUpJtiStore.consume` gives a step-up jti, for the
   * same reason: a `get` followed by a `delete` leaves a window in which two
   * concurrent presentations of one single-use secret both pass the check.
   * Unlike {@link delete} it answers, so the caller can act on having won
   * rather than assuming it.
   */
  consume(key: string): Promise<boolean>;
}

/** Hard ceiling on in-memory entries per store — belt to the TTL-sweep braces. */
export const CEREMONY_STORE_MAX = 10_000;

/**
 * The full TTL scan runs at most once per this window, mirroring the
 * `maybeSweepExpiredTokens` debounce in `@shared/crypto`'s arc.ts. Lazy
 * expiry on `get` keeps stale reads correct between sweeps.
 */
const SWEEP_DEBOUNCE_MS = 30_000;

interface MemoryEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * In-memory ceremony store — single-process dev/test. Mirrors the old inline
 * `Map` behaviour with amortised eviction: `get` lazily drops an expired
 * entry it touches, `set` triggers a debounced full TTL sweep (at most once
 * per {@link SWEEP_DEBOUNCE_MS}), and a FIFO drop enforced on every `set`
 * keeps the map hard-bounded under abuse even if every entry is still live.
 */
export function createInMemoryCeremonyStore<V>(
  namespace: CeremonyStoreName,
  observer: CeremonyStoreObserver = {},
): CeremonyStore<V> {
  const entries = new Map<string, MemoryEntry<V>>();
  let lastSweepMs = 0;

  function sweepExpired(): void {
    const nowMs = Date.now();
    for (const [k, entry] of entries) {
      if (entry.expiresAt <= nowMs) {
        entries.delete(k);
        observer.onEntryDelta?.(-1, namespace);
      }
    }
  }

  function maybeSweep(): void {
    const nowMs = Date.now();
    if (nowMs - lastSweepMs >= SWEEP_DEBOUNCE_MS) {
      lastSweepMs = nowMs;
      sweepExpired();
    }
    // Bound: enforced on EVERY set (not debounced) so the hard cap holds.
    // On a breach, sweep expired entries first so live ones are only FIFO-
    // dropped as a last resort, then drop oldest insertions (Map preserves
    // insertion order) until back under the cap.
    if (entries.size > CEREMONY_STORE_MAX) {
      sweepExpired();
      while (entries.size > CEREMONY_STORE_MAX) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
        observer.onEntryDelta?.(-1, namespace);
      }
    }
  }

  return {
    backend: "memory",
    namespace,
    async set(key, value, ttlMs) {
      maybeSweep();
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
    async consume(key) {
      observer.onOp?.("delete", namespace);
      const entry = entries.get(key);
      if (!entry) return false;
      entries.delete(key);
      observer.onEntryDelta?.(-1, namespace);
      // An entry past its TTL is not a live claim, so removing it wins nothing.
      return entry.expiresAt > Date.now();
    },
  };
}
