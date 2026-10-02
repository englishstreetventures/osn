// A `weddingId`-keyed cache for the locked modules' row counts (`GET
// …/module-rows`) — sibling of `upgrade-store.ts`. The locked Budget, Checklist
// and Registry cards read it, on the rail and in the sheet, and each card
// mounts afresh every time it opens; without the cache every open would ask
// again, and each ask spends the owner's per-user export allowance that the
// downloads themselves need.
//
// One answer per wedding while its dashboard is on screen. A locked module
// refuses its own writes, so the counts hold still in that time; a gift payment
// settling meanwhile is the one exception, and the file itself is always read
// fresh.
//
// Effect is deliberately NOT imported (frontend code).
import { type Accessor, createSignal, type Setter } from "solid-js";

import type { ModuleRows } from "./locked-exports";
import { isWeddingClosed } from "./wedding-scope";

interface CacheEntry {
  rows: Accessor<ModuleRows | null>;
  setRows: Setter<ModuleRows | null>;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<boolean>>();
/** Bumped by every drop, so a load started before it caches nothing. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [rows, setRows] = createSignal<ModuleRows | null>(null);
    entry = { rows, setRows };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** The subscribing read: `null` until the counts have loaded. */
export function moduleRowsAccessor(weddingId: string): Accessor<ModuleRows | null> {
  return entryFor(weddingId).rows;
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function hasCachedModuleRows(weddingId: string): boolean {
  return cache.get(weddingId)?.rows() != null;
}

/**
 * Load the counts once. Resolves `true` when they are cached, `false` when the
 * wedding is closed or a drop overtook the load. A failed fetch rejects with
 * its error and caches nothing, so the next caller asks again. Concurrent
 * callers share one request.
 */
export function ensureModuleRowsLoaded(
  weddingId: string,
  fetcher: () => Promise<ModuleRows>,
): Promise<boolean> {
  if (isWeddingClosed(weddingId)) return Promise.resolve(false);
  if (hasCachedModuleRows(weddingId)) return Promise.resolve(true);
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then((rows) => {
        if (generationOf(weddingId) !== startedAt || isWeddingClosed(weddingId)) return false;
        entryFor(weddingId).setRows(rows);
        return true;
      })
      .finally(() => {
        if (inflight.get(weddingId) === load) inflight.delete(weddingId);
      });
    pending = load;
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Forget a wedding's counts. A view still holding the old accessor reads
 *  `null` from then on. */
export function dropModuleRows(weddingId: string): void {
  cache.get(weddingId)?.setRows(null);
  cache.delete(weddingId);
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Test-only: the module cache outlives a test file otherwise. */
export function __resetModuleRowsStore(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
}
