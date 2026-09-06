// A `weddingId`-keyed cache for the organiser's vendor CRM — sibling of
// `budget-store.ts`/`tasks-store.ts`. Fetch-lift so switching modules doesn't
// refetch, and so the Overview vendor-count widget + the Vendors view share ONE
// fetch. Effect is deliberately NOT imported (frontend code). Timestamps are
// ms-epoch numbers.
import { type Accessor, createSignal, type Setter } from "solid-js";

/** One vendor row as the organiser API returns it (timestamps are ms-epoch numbers). */
export interface VendorRow {
  id: string;
  weddingId: string;
  directoryVendorId: string | null;
  name: string;
  category: string;
  /** researching | contacted | quoted | booked | declined */
  status: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  quotedMinor: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface CacheEntry {
  vendors: Accessor<VendorRow[] | null>;
  setVendors: Setter<VendorRow[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [vendors, setVendors] = createSignal<VendorRow[] | null>(null);
    entry = { vendors, setVendors };
    cache.set(weddingId, entry);
  }
  return entry;
}

export function vendorsAccessor(weddingId: string): Accessor<VendorRow[] | null> {
  return entryFor(weddingId).vendors;
}

export function hasCachedVendors(weddingId: string): boolean {
  return cache.get(weddingId)?.vendors() != null;
}

export function setCachedVendors(weddingId: string, vendors: VendorRow[]): void {
  entryFor(weddingId).setVendors(vendors);
}

export function peekCachedVendors(weddingId: string): VendorRow[] | null {
  return cache.get(weddingId)?.vendors() ?? null;
}

export function invalidateVendors(weddingId: string): void {
  entryFor(weddingId).setVendors(null);
  // A load already in flight was issued against PRE-mutation state, so its rows
  // are stale the moment this runs. Clearing the signal alone is not enough —
  // the fetch's own `.then` would still write them in AFTER this call — so the
  // wedding's GENERATION is bumped too, and a resolving fetch from an older
  // generation discards its result instead of caching it.
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** Reactive vendor count for the Overview widget: `null` before first load. */
export function vendorCount(weddingId: string): number | null {
  const rows = cache.get(weddingId)?.vendors() ?? null;
  if (rows == null) return null;
  return rows.length;
}

const inflight = new Map<string, Promise<void>>();

export function ensureVendorsLoaded(
  weddingId: string,
  fetcher: () => Promise<VendorRow[]>,
): Promise<void> {
  if (hasCachedVendors(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then((rows) => {
        // A newer invalidation landed while this was in flight — its rows
        // describe state that has since been mutated, so drop them rather than
        // cache them.
        if (generationOf(weddingId) !== startedAt) return;
        setCachedVendors(weddingId, rows);
      })
      .finally(() => {
        // Only clear the slot if it is still OURS: an invalidation may already
        // have replaced it with a newer load.
        if (inflight.get(weddingId) === load) inflight.delete(weddingId);
      });
    pending = load;
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetVendorsCache(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
}
