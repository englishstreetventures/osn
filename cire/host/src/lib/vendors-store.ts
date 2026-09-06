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

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function hasCachedVendors(weddingId: string): boolean {
  return !stale.has(weddingId) && cache.get(weddingId)?.vendors() != null;
}

export function setCachedVendors(weddingId: string, vendors: VendorRow[]): void {
  entryFor(weddingId).setVendors(vendors);
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function peekCachedVendors(weddingId: string): VendorRow[] | null {
  return cache.get(weddingId)?.vendors() ?? null;
}

export function invalidateVendors(weddingId: string): void {
  // A mounted Vendors view is still rendering the last-known rows, and pulling
  // them out from under it for one round trip is the flicker this cache
  // exists to avoid — so the signal is left alone and the wedding is marked
  // `stale` instead. `hasCachedVendors` treats a stale id as a miss, which is
  // what makes the next `ensureVendorsLoaded` actually refetch rather than
  // short-circuiting on the (still-present) cached value.
  stale.add(weddingId);
  // A load already in flight was issued against PRE-mutation state, so its
  // rows describe state that has since been mutated: the wedding's
  // GENERATION is bumped too, and a resolving fetch from an older generation
  // discards its result instead of caching it. Dropping the in-flight slot
  // here (not just bumping the generation) means the next
  // `ensureVendorsLoaded` does not join that doomed fetch — it starts a new
  // one, at the cost of one extra request. That is the right trade: joining
  // would await a promise whose result the generation guard is about to
  // discard, leaving the caller with `false` and the view unrefreshed until
  // whatever call comes next.
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** Wedding ids whose cached rows are known out of date but still worth showing
 *  while the refetch is in flight. */
const stale = new Set<string>();

/** Reactive vendor count for the Overview widget: `null` before first load.
 *  Mints the wedding's cache entry so the read subscribes even from a cold
 *  cache — the entry is per-wedding and bounded by the same key space
 *  `cache`, `generation` and `stale` already occupy. */
export function vendorCount(weddingId: string): number | null {
  const rows = entryFor(weddingId).vendors();
  if (rows == null) return null;
  return rows.length;
}

const inflight = new Map<string, Promise<boolean>>();

export function ensureVendorsLoaded(
  weddingId: string,
  fetcher: () => Promise<VendorRow[]>,
): Promise<boolean> {
  if (hasCachedVendors(weddingId)) return Promise.resolve(true);
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then(
        (rows) => {
          // A newer invalidation landed while this was in flight — its rows
          // describe state that has since been mutated, so drop them rather than
          // cache them.
          if (generationOf(weddingId) !== startedAt) return false;
          setCachedVendors(weddingId, rows);
          stale.delete(weddingId);
          return true;
        },
        (err: unknown) => {
          // The refetch was refused or failed. The rows still on screen were
          // fetched under an authorisation this request could not confirm, so
          // they stop being shown: a demoted organiser must not keep reading
          // vendor detail behind an error banner. Same generation guard — if
          // a newer invalidation has landed, a newer load owns the entry and
          // this one touches nothing.
          if (generationOf(weddingId) === startedAt) {
            entryFor(weddingId).setVendors(null);
            stale.delete(weddingId);
          }
          throw err;
        },
      )
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
  stale.clear();
}
