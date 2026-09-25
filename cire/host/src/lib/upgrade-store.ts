// A `weddingId`-keyed cache for the upgrade catalogue — sibling of
// `budget-store.ts`. Fetch-lift so opening two locked modules in a row does not
// re-price them, and so every locked nav row shares ONE fetch.
//
// Effect is deliberately NOT imported (frontend code).
import { type Accessor, createSignal, type Setter } from "solid-js";

import type { CatalogueEntry } from "./upgrade-api";
import { isWeddingClosed } from "./wedding-scope";

interface CacheEntry {
  catalogue: Accessor<CatalogueEntry[] | null>;
  setCatalogue: Setter<CatalogueEntry[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [catalogue, setEntries] = createSignal<CatalogueEntry[] | null>(null);
    entry = { catalogue, setCatalogue: setEntries };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** The subscribing read. Mints the entry, so a tracked read always has a signal
 *  to register a dependency on even before the fetch lands. */
export function catalogueAccessor(weddingId: string): Accessor<CatalogueEntry[] | null> {
  return entryFor(weddingId).catalogue;
}

/** Ignored for a closed wedding (see `wedding-scope.ts`): the dialog that
 *  asked for the prices has already been torn down. */
export function setCatalogue(weddingId: string, entries: CatalogueEntry[]): void {
  if (isWeddingClosed(weddingId)) return;
  entryFor(weddingId).setCatalogue(entries);
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track. */
export function hasCachedCatalogue(weddingId: string): boolean {
  return cache.get(weddingId)?.catalogue() != null;
}

/** Drop a wedding's cached prices — after a purchase settles, so the dialog
 *  cannot keep offering something the wedding now holds. */
export function invalidateCatalogue(weddingId: string): void {
  cache.get(weddingId)?.setCatalogue(null);
}

/** Forget a wedding's prices. A view still holding the old accessor reads
 *  `null` from then on. */
export function dropCatalogue(weddingId: string): void {
  cache.get(weddingId)?.setCatalogue(null);
  cache.delete(weddingId);
}

/** Test-only: the module cache outlives a test file otherwise. */
export function __resetUpgradeStore(): void {
  cache.clear();
}
