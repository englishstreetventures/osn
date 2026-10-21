// A per-wedding cache of one read, with the rules every view of task-shaped data
// shares: a load in flight across an invalidation is dropped, a read across one
// of the portal's own writes is dropped and sent again, and signals to re-read
// coalesce. The checklist's tasks (`tasks-store.ts`) and the run sheet
// (`run-sheet-store.ts`) are each one of these, sharing one write tracker.
// Frontend code: no Effect.
import { type Accessor, createSignal, type Setter } from "solid-js";

import type { WriteTracker } from "./task-writes";
import { isWeddingClosed } from "./wedding-scope";

export interface RereadCacheOptions {
  /** The portal's writes whose answers a read must not undo. */
  writes: WriteTracker;
  /**
   * Mark the wedding stale each time one of those writes ends. For a cache the
   * writes change but do not answer — the run sheet, after a checklist write —
   * so the next view to open reads again even when no push arrives.
   */
  staleOnWriteEnd: boolean;
}

export interface RereadCache<T> {
  /** The wedding's value, `null` until loaded. Mints the entry, so a view
   *  subscribes even from a cold cache. */
  accessor(weddingId: string): Accessor<T | null>;
  /** A fresh value is cached. Subscribes only when the entry already exists —
   *  never use it for a value a view must track. */
  has(weddingId: string): boolean;
  /** Write a value, unless the wedding has been left. */
  setCached(weddingId: string, value: T): void;
  /** Write the whole value a write just answered with: the newest read there
   *  is, so the wedding is fresh again, and a load already in flight drops
   *  what it fetches. */
  setFresh(weddingId: string, value: T): void;
  /** The value, without minting the entry. Subscribes only when it exists. */
  peek(weddingId: string): T | null;
  /** The value is known out of date: keep showing it, read again on the next
   *  load, and drop any load in flight. */
  invalidate(weddingId: string): void;
  /** The value may be out of date: read again on the next load, but let a
   *  load in flight land (and still leave the wedding stale). */
  markStale(weddingId: string): void;
  /** Read again because a signal said the value changed, coalescing with any
   *  read in flight and waiting for the portal's own writes. */
  reread(weddingId: string, fetcher: () => Promise<T>): Promise<boolean>;
  /** Load the value unless a fresh one is cached; one load in flight per
   *  wedding. Resolves `true` once it is cached, `false` when the load was
   *  dropped, and rejects (blanking the value) when it fails. */
  ensureLoaded(weddingId: string, fetcher: () => Promise<T>): Promise<boolean>;
  /** Forget the wedding: release its value and any read owed it. */
  drop(weddingId: string): void;
  /** Test-only: forget every wedding. */
  reset(): void;
}

export function createRereadCache<T>(options: RereadCacheOptions): RereadCache<T> {
  const { writes } = options;

  interface CacheEntry {
    value: Accessor<T | null>;
    setValue: Setter<T | null>;
  }

  const cache = new Map<string, CacheEntry>();

  function entryFor(weddingId: string): CacheEntry {
    let entry = cache.get(weddingId);
    if (!entry) {
      const [value, setValue] = createSignal<T | null>(null);
      entry = { value, setValue };
      cache.set(weddingId, entry);
    }
    return entry;
  }

  /** Wedding ids whose cached value is known out of date but still worth
   *  showing while the refetch is in flight. */
  const stale = new Set<string>();

  /** Monotonic per-wedding load generation, bumped by every invalidation, by a
   *  write's whole answer and by forgetting the wedding: a load from an older
   *  generation has been replaced, and drops what it fetches. */
  const generation = new Map<string, number>();
  const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

  /** Per-wedding count of {@link RereadCache.markStale} calls: a load that sees
   *  it move may predate the change it was told of. */
  const staleMarks = new Map<string, number>();
  const staleMarksOf = (weddingId: string) => staleMarks.get(weddingId) ?? 0;

  const inflight = new Map<string, Promise<boolean>>();

  /** A read the cache owes a wedding, and the promise every view that asked
   *  waits on. */
  interface Reread {
    fetcher: () => Promise<T>;
    readonly settled: Promise<boolean>;
    readonly start: (load: Promise<boolean>) => void;
  }

  const rereads = new Map<string, Reread>();

  function has(weddingId: string): boolean {
    return !stale.has(weddingId) && cache.get(weddingId)?.value() != null;
  }

  function setCached(weddingId: string, value: T): void {
    if (isWeddingClosed(weddingId)) return;
    entryFor(weddingId).setValue(() => value);
  }

  function markStale(weddingId: string): void {
    stale.add(weddingId);
    staleMarks.set(weddingId, staleMarksOf(weddingId) + 1);
  }

  function queueReread(weddingId: string, fetcher: () => Promise<T>): Promise<boolean> {
    const queued = rereads.get(weddingId);
    if (queued) {
      queued.fetcher = fetcher;
      return queued.settled;
    }
    let start!: (load: Promise<boolean>) => void;
    const settled = new Promise<boolean>((resolve) => {
      start = resolve;
    });
    // A read queued again after a drop has no caller of its own; a failure is
    // still handed to every view that asked for it.
    settled.catch(() => undefined);
    rereads.set(weddingId, { fetcher, settled, start });
    return settled;
  }

  /** Send the read a wedding is owed, unless a read is in flight or one of the
   *  portal's own writes is out: each calls this again when it ends. */
  function sendReread(weddingId: string): void {
    const queued = rereads.get(weddingId);
    if (!queued || writes.isOut(weddingId) || inflight.has(weddingId)) return;
    rereads.delete(weddingId);
    // The wedding is still stale unless a read that started after the signal,
    // and after the tab's writes, has landed: then this answers from the cache.
    queued.start(ensureLoaded(weddingId, queued.fetcher));
  }

  /** Settle a wedding's owed read as not loaded, and send nothing. */
  function forgetReread(weddingId: string): void {
    rereads.get(weddingId)?.start(Promise.resolve(false));
    rereads.delete(weddingId);
  }

  function ensureLoaded(weddingId: string, fetcher: () => Promise<T>): Promise<boolean> {
    // A closed wedding loads nothing: the caller is a view that has already
    // been torn down.
    if (isWeddingClosed(weddingId)) return Promise.resolve(false);
    if (has(weddingId)) return Promise.resolve(true);
    let pending = inflight.get(weddingId);
    if (!pending) {
      const startedAt = generationOf(weddingId);
      const startedEpoch = writes.epoch(weddingId);
      const startedMarks = staleMarksOf(weddingId);
      const load = fetcher()
        .then(
          (value) => {
            // A newer invalidation or a write's whole answer landed while this
            // was in flight: a newer load owns the entry, so drop the value.
            if (generationOf(weddingId) !== startedAt) return false;
            // One of the portal's own writes started or ended while this was in
            // flight, or one is out now: the value may predate it. Drop it and
            // read again once the last write has ended.
            if (writes.epoch(weddingId) !== startedEpoch || writes.isOut(weddingId)) {
              void queueReread(weddingId, fetcher);
              return false;
            }
            setCached(weddingId, value);
            if (staleMarksOf(weddingId) === startedMarks) stale.delete(weddingId);
            return true;
          },
          (err: unknown) => {
            // The refetch was refused or failed. The value still on screen was
            // fetched under an authorisation this request could not confirm, so
            // it stops being shown: a demoted organiser must not keep reading
            // it behind an error banner. Same generation guard — if a newer
            // invalidation has landed, a newer load owns the entry and this one
            // touches nothing.
            if (generationOf(weddingId) === startedAt) {
              entryFor(weddingId).setValue(null);
              stale.delete(weddingId);
            }
            throw err;
          },
        )
        .finally(() => {
          // Only clear the slot if it is still OURS: an invalidation may
          // already have replaced it with a newer load.
          if (inflight.get(weddingId) === load) inflight.delete(weddingId);
          sendReread(weddingId);
        });
      pending = load;
      inflight.set(weddingId, pending);
    }
    return pending;
  }

  writes.onEnd((weddingId) => {
    if (options.staleOnWriteEnd && cache.has(weddingId)) markStale(weddingId);
    sendReread(weddingId);
  });

  return {
    accessor: (weddingId) => entryFor(weddingId).value,
    has,
    setCached,
    setFresh(weddingId, value) {
      if (isWeddingClosed(weddingId)) return;
      generation.set(weddingId, generationOf(weddingId) + 1);
      entryFor(weddingId).setValue(() => value);
      stale.delete(weddingId);
    },
    peek: (weddingId) => cache.get(weddingId)?.value() ?? null,
    invalidate(weddingId) {
      // A mounted view is still rendering the last-known value, and pulling it
      // out from under it for one round trip is the flicker this cache exists
      // to avoid — so the signal is left alone and the wedding is marked
      // `stale` instead, which `has` treats as a miss.
      stale.add(weddingId);
      // A load already in flight was issued against pre-mutation state: the
      // generation is bumped so it discards its result, and its slot dropped
      // so the next load starts a new one rather than awaiting a doomed fetch.
      inflight.delete(weddingId);
      generation.set(weddingId, generationOf(weddingId) + 1);
    },
    markStale,
    reread(weddingId, fetcher) {
      if (isWeddingClosed(weddingId)) return Promise.resolve(false);
      markStale(weddingId);
      const settled = queueReread(weddingId, fetcher);
      sendReread(weddingId);
      return settled;
    },
    ensureLoaded,
    drop(weddingId) {
      // The generation is bumped rather than deleted: a deleted one reads as
      // 0, the value an old load captured, and that load would then cache.
      cache.get(weddingId)?.setValue(null);
      cache.delete(weddingId);
      inflight.delete(weddingId);
      stale.delete(weddingId);
      forgetReread(weddingId);
      generation.set(weddingId, generationOf(weddingId) + 1);
    },
    reset() {
      for (const weddingId of rereads.keys()) forgetReread(weddingId);
      cache.clear();
      inflight.clear();
      generation.clear();
      staleMarks.clear();
      stale.clear();
    },
  };
}
