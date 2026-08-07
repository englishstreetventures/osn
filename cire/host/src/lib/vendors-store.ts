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
  cache.delete(weddingId);
}

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
    pending = fetcher()
      .then((rows) => {
        setCachedVendors(weddingId, rows);
        return undefined;
      })
      .finally(() => inflight.delete(weddingId));
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetVendorsCache(): void {
  cache.clear();
  inflight.clear();
}
