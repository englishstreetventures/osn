// One per-wedding cache of one read, with the contract every organiser cache
// shares (wiki: cire-host-portal-layout, "Organiser client caches"): a fresh
// value answers without a request; a stale one stays on screen while the next
// load reads again; a load that lands after an invalidate, a write's answer or
// a patch caches nothing; a refused read blanks the value; a closed wedding
// loads and keeps nothing.
//
// A patch is the one write that keeps the value's age. With a load in flight it
// drops that load and marks the patched value stale, since the read was sent
// before the write and its answer may not hold it; the next load reads again.
//
// On top of that, a value goes stale on its own `maxAgeMs` after it was read.
// The caches built here hold data that guests, co-hosts and other organisers
// change with no push reaching this tab, so a revisit soon after a read answers
// from memory and a later one reads again behind the value it shows.
//
// Frontend code: no Effect.
import { type Accessor, createSignal, type Setter } from "solid-js";

import { isWeddingClosed } from "./wedding-scope";

/**
 * How long a value read for one of these caches counts as fresh. Long enough
 * that moving between views answers from memory, short enough that a reply or
 * a co-host's edit shows within a minute of the next visit.
 */
export const CACHE_MAX_AGE_MS = 60_000;

export interface WeddingCache<T> {
  /** The wedding's value, `null` until loaded. Mints the entry, so a view
   *  subscribes even from a cold cache. */
  accessor(weddingId: string): Accessor<T | null>;
  /** A value is cached, not marked stale and younger than the max age.
   *  Subscribes only when the entry already exists — never use it for a value
   *  a view must track. */
  has(weddingId: string): boolean;
  /** The value, without minting the entry. Subscribes only when it exists. */
  peek(weddingId: string): T | null;
  /** Write a patched value. Keeps a stale mark and the value's age. With a
   *  load in flight, drops that load and marks the value stale: the read went
   *  out before the write, so its answer cannot replace the patch, and the
   *  next load reads again. */
  setCached(weddingId: string, value: T): void;
  /** Write the whole value a server answer just gave: fresh again, its age
   *  restarted, and a load already in flight drops what it fetches. */
  setFresh(weddingId: string, value: T): void;
  /** The value is known out of date: keep showing it, read again on the next
   *  load, and drop any load in flight. */
  invalidate(weddingId: string): void;
  /** A read the caller made on its own was refused or failed: the value it
   *  had shown stops being shown, as a refused `ensureLoaded` does, and a load
   *  in flight drops what it fetches. */
  refuse(weddingId: string): void;
  /** Load the value unless a fresh one is cached; one load in flight per
   *  wedding. Resolves `true` once it is cached, `false` when the load was
   *  dropped or the wedding is closed, and rejects (blanking the value) when
   *  it fails. */
  ensureLoaded(weddingId: string, fetcher: () => Promise<T>): Promise<boolean>;
  /** Forget the wedding: release its value and any load in flight. */
  drop(weddingId: string): void;
  /** Test-only: forget every wedding. */
  reset(): void;
}

export function createWeddingCache<T>(options: { maxAgeMs: number }): WeddingCache<T> {
  interface CacheEntry {
    value: Accessor<T | null>;
    setValue: Setter<T | null>;
  }

  const cache = new Map<string, CacheEntry>();
  /** When each wedding's value was last read or answered, by `Date.now()`. */
  const readAt = new Map<string, number>();
  /** Weddings whose value is known out of date but still worth showing. */
  const stale = new Set<string>();
  /** Bumped by every invalidate, write answer and drop, and by a patch that
   *  lands while a load is out: a load from an older generation has been
   *  replaced, and drops what it fetches. */
  const generation = new Map<string, number>();
  const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;
  const bump = (weddingId: string) => generation.set(weddingId, generationOf(weddingId) + 1);
  const inflight = new Map<string, Promise<boolean>>();

  function entryFor(weddingId: string): CacheEntry {
    let entry = cache.get(weddingId);
    if (!entry) {
      const [value, setValue] = createSignal<T | null>(null);
      entry = { value, setValue };
      cache.set(weddingId, entry);
    }
    return entry;
  }

  function has(weddingId: string): boolean {
    if (stale.has(weddingId) || cache.get(weddingId)?.value() == null) return false;
    return Date.now() - (readAt.get(weddingId) ?? 0) < options.maxAgeMs;
  }

  function ensureLoaded(weddingId: string, fetcher: () => Promise<T>): Promise<boolean> {
    // A closed wedding loads nothing: the caller is a view already torn down.
    if (isWeddingClosed(weddingId)) return Promise.resolve(false);
    if (has(weddingId)) return Promise.resolve(true);
    let pending = inflight.get(weddingId);
    if (!pending) {
      const startedAt = generationOf(weddingId);
      const load = fetcher()
        .then(
          (value) => {
            // A newer invalidate or write answer landed while this was out: a
            // newer load owns the entry, so the value is dropped.
            if (generationOf(weddingId) !== startedAt || isWeddingClosed(weddingId)) return false;
            entryFor(weddingId).setValue(() => value);
            readAt.set(weddingId, Date.now());
            stale.delete(weddingId);
            return true;
          },
          (err: unknown) => {
            // The read was refused or failed. The value on screen was read
            // under an authorisation this request could not confirm, so it
            // stops being shown — unless a newer load owns the entry.
            if (generationOf(weddingId) === startedAt) {
              cache.get(weddingId)?.setValue(null);
              stale.delete(weddingId);
            }
            throw err;
          },
        )
        .finally(() => {
          if (inflight.get(weddingId) === load) inflight.delete(weddingId);
        });
      pending = load;
      inflight.set(weddingId, pending);
    }
    return pending;
  }

  return {
    accessor: (weddingId) => entryFor(weddingId).value,
    has,
    peek: (weddingId) => cache.get(weddingId)?.value() ?? null,
    setCached(weddingId, value) {
      if (isWeddingClosed(weddingId)) return;
      // A load sent before the write could land after it and put back what
      // the write changed: it drops what it fetches, and the patched value is
      // read again on the next load.
      if (inflight.has(weddingId)) {
        bump(weddingId);
        inflight.delete(weddingId);
        stale.add(weddingId);
      }
      entryFor(weddingId).setValue(() => value);
    },
    setFresh(weddingId, value) {
      if (isWeddingClosed(weddingId)) return;
      bump(weddingId);
      inflight.delete(weddingId);
      entryFor(weddingId).setValue(() => value);
      readAt.set(weddingId, Date.now());
      stale.delete(weddingId);
    },
    invalidate(weddingId) {
      // A mounted view keeps the value it shows; the mark makes the next load
      // read again, and the bump drops a load sent before the change.
      stale.add(weddingId);
      inflight.delete(weddingId);
      bump(weddingId);
    },
    refuse(weddingId) {
      cache.get(weddingId)?.setValue(null);
      readAt.delete(weddingId);
      stale.delete(weddingId);
      inflight.delete(weddingId);
      bump(weddingId);
    },
    ensureLoaded,
    drop(weddingId) {
      // Bumped, never deleted: a deleted generation reads as 0, the value an
      // old load captured, and that load would then cache.
      cache.get(weddingId)?.setValue(null);
      cache.delete(weddingId);
      readAt.delete(weddingId);
      inflight.delete(weddingId);
      stale.delete(weddingId);
      bump(weddingId);
    },
    reset() {
      cache.clear();
      readAt.clear();
      inflight.clear();
      generation.clear();
      stale.clear();
    },
  };
}
