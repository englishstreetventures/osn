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
 * pending-registration payloads, …). A code ceremony's guess count is kept
 * beside the value on the same entry, and moved only by `guess`.
 *
 * A backend error propagates from every operation; the call site decides what
 * the request answers.
 */

import type { CeremonyStoreName } from "./coordination/names";

export type CeremonyStoreBackend = "memory" | "durable_object";

/** What the ceremony-store metric counts. `consume` counts as a `delete`. */
export type CeremonyStoreOp = "set" | "get" | "delete" | "guess" | "take" | "swap";

/** Hooks an in-memory store calls as it works. */
export interface CeremonyStoreObserver {
  /** Every operation; `stores.ts` counts these on the ceremony-store metric. */
  onOp?: (op: CeremonyStoreOp, namespace: CeremonyStoreName) => void;
  /**
   * +1 when a new key is stored, -1 when one leaves — by delete, by expiry or
   * by the size cap. Nothing in the service listens; it is how a caller can
   * watch the sweep and the cap keep the map bounded.
   */
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
  /**
   * Count one guess against the live entry at `key` and return the entry with
   * the count after this guess, in one atomic call: guesses sent at once each
   * get their own number, and none can read the entry and then count from a
   * number the entry no longer has. With no live entry nothing is counted and
   * the answer is `{ value: null, n: 0 }`.
   *
   * The count lives on the entry: {@link set} restarts it, and {@link delete},
   * {@link consume} and {@link take} clear it with the entry.
   */
  guess(key: string): Promise<{ value: V | null; n: number }>;
  /**
   * The live value at `key`, removed in the same call, or `null`. Of two
   * takes at once exactly one gets the value — the single-use read for an
   * entry that is spent the moment it is read.
   */
  take(key: string): Promise<V | null>;
  /**
   * Replace the live value at `key` with `value` for `ttlMs` only if it is
   * `expected` — a value an earlier {@link get} answered, compared as JSON —
   * or, for `expected` `null`, only if nothing live is there. Answers whether
   * THIS call replaced it: of several swaps from one value at once, exactly
   * one wins. The guess count restarts, as on {@link set}. A swap that does
   * not match leaves a live entry as it was, value, count and expiry.
   */
  swap(key: string, expected: V | null, value: V, ttlMs: number): Promise<boolean>;
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
  /** Guesses counted against this value; a new `set` starts again at 0. */
  guesses: number;
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

  /** The live entry at `key`; an expired one is dropped on the way. */
  function live(key: string): MemoryEntry<V> | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      observer.onEntryDelta?.(-1, namespace);
      return undefined;
    }
    return entry;
  }

  /** Remove `key`, and answer what was live there. */
  function remove(key: string): MemoryEntry<V> | undefined {
    const found = live(key);
    if (entries.delete(key)) observer.onEntryDelta?.(-1, namespace);
    return found;
  }

  // Every method reads and writes the map with no `await` in between, so each
  // is atomic against the others, as one Durable Object call is.
  return {
    backend: "memory",
    namespace,
    async set(key, value, ttlMs) {
      maybeSweep();
      const existed = entries.has(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs, guesses: 0 });
      observer.onOp?.("set", namespace);
      if (!existed) observer.onEntryDelta?.(1, namespace);
    },
    async get(key) {
      observer.onOp?.("get", namespace);
      return live(key)?.value ?? null;
    },
    async delete(key) {
      observer.onOp?.("delete", namespace);
      remove(key);
    },
    async consume(key) {
      observer.onOp?.("delete", namespace);
      // An entry past its TTL is not a live claim, so removing it wins nothing.
      return remove(key) !== undefined;
    },
    async guess(key) {
      observer.onOp?.("guess", namespace);
      const entry = live(key);
      if (!entry) return { value: null, n: 0 };
      entry.guesses += 1;
      return { value: entry.value, n: entry.guesses };
    },
    async take(key) {
      observer.onOp?.("take", namespace);
      return remove(key)?.value ?? null;
    },
    async swap(key, expected, value, ttlMs) {
      observer.onOp?.("swap", namespace);
      const entry = live(key);
      const current = entry === undefined ? null : JSON.stringify(entry.value);
      if (current !== (expected === null ? null : JSON.stringify(expected))) return false;
      maybeSweep();
      const existed = entries.has(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs, guesses: 0 });
      if (!existed) observer.onEntryDelta?.(1, namespace);
      return true;
    },
  };
}
