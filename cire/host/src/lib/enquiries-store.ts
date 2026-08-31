// A `weddingId`-keyed cache for the organiser's enquiry inbox — sibling of
// `vendors-store.ts`/`budget-store.ts`. Fetch-lift so switching modules doesn't
// refetch, and so the Overview enquiry-count widget + the Enquiries view share ONE
// fetch. Effect is deliberately NOT imported (frontend code). Timestamps are
// ms-epoch numbers.
import { type Accessor, createSignal, type Setter } from "solid-js";

/** One enquiry row as the organiser API returns it (timestamps are ms-epoch numbers). */
export interface EnquiryListItem {
  id: string;
  weddingId: string;
  directoryVendorId: string;
  vendorId: string;
  zapChatId: string | null;
  /** open | quoted | closed */
  status: "open" | "quoted" | "closed";
  createdBy: string;
  quotedMinor: number | null;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
  vendorName: string;
  category: string;
}

export interface EnquiryMessage {
  id: string;
  senderProfileId: string;
  body: string;
  createdAt: number;
}

interface CacheEntry {
  enquiries: Accessor<EnquiryListItem[] | null>;
  setEnquiries: Setter<EnquiryListItem[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [enquiries, setEnquiries] = createSignal<EnquiryListItem[] | null>(null);
    entry = { enquiries, setEnquiries };
    cache.set(weddingId, entry);
  }
  return entry;
}

export function enquiriesAccessor(weddingId: string): Accessor<EnquiryListItem[] | null> {
  return entryFor(weddingId).enquiries;
}

export function hasCachedEnquiries(weddingId: string): boolean {
  return cache.get(weddingId)?.enquiries() != null;
}

export function setCachedEnquiries(weddingId: string, items: EnquiryListItem[]): void {
  entryFor(weddingId).setEnquiries(items);
}

export function peekCachedEnquiries(weddingId: string): EnquiryListItem[] | null {
  return cache.get(weddingId)?.enquiries() ?? null;
}

export function invalidateEnquiries(weddingId: string): void {
  entryFor(weddingId).setEnquiries(null);
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

export function upsertCachedEnquiry(weddingId: string, next: EnquiryListItem): void {
  const cur = peekCachedEnquiries(weddingId) ?? [];
  const without = cur.filter((e) => e.id !== next.id);
  setCachedEnquiries(
    weddingId,
    [next, ...without].toSorted((a, b) => b.lastMessageAt - a.lastMessageAt),
  );
}

const inflight = new Map<string, Promise<void>>();

export function ensureEnquiriesLoaded(
  weddingId: string,
  fetcher: () => Promise<EnquiryListItem[]>,
): Promise<void> {
  if (hasCachedEnquiries(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then((items) => {
        // A newer invalidation landed while this was in flight — its rows
        // describe state that has since been mutated, so drop them rather than
        // cache them.
        if (generationOf(weddingId) !== startedAt) return;
        setCachedEnquiries(weddingId, items);
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
export function __resetEnquiriesCache(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
}
