// The vendor directory's first page with no filter (`GET …/directory`), cached
// per wedding so the Browse tab reopens on it without a request. A filtered or
// later page is read when asked for, as before.
//
// Each listing says whether the wedding already has that vendor, so adding one
// from the directory patches the page, and deleting a vendor drops it. A
// vendor's own edit shows once the page is a minute old.
//
// Frontend code: no Effect.
import { CACHE_MAX_AGE_MS, createWeddingCache } from "./wedding-cache";

export interface BrowseListing {
  id: string;
  name: string;
  description: string | null;
  categories: string[];
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  website: string | null;
  instagram: string | null;
  email: string | null;
  phone: string | null;
  inWedding: boolean;
}

export interface DirectoryPage {
  listings: BrowseListing[];
  total: number;
}

const cache = createWeddingCache<DirectoryPage>({ maxAgeMs: CACHE_MAX_AGE_MS });

/** The unfiltered first page, when still fresh. */
export function freshDirectoryPage(weddingId: string): DirectoryPage | null {
  return cache.has(weddingId) ? cache.peek(weddingId) : null;
}

/** The unfiltered first page, just read. */
export const setFreshDirectoryPage = (weddingId: string, page: DirectoryPage) =>
  cache.setFresh(weddingId, page);

/** The wedding now has this listing's vendor. */
export function markDirectoryListingAdded(weddingId: string, listingId: string): void {
  const page = cache.peek(weddingId);
  if (!page) return;
  cache.setCached(weddingId, {
    ...page,
    listings: page.listings.map((l) => (l.id === listingId ? { ...l, inWedding: true } : l)),
  });
}

/** A vendor left the wedding: a listing may no longer be in it. */
export const invalidateDirectoryPage = (weddingId: string) => cache.invalidate(weddingId);
export const dropDirectoryPage = (weddingId: string) => cache.drop(weddingId);
/** Test-only. */
export const __resetDirectoryCache = () => cache.reset();
