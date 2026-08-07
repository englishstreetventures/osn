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
  cache.delete(weddingId);
}

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
    pending = fetcher()
      .then((items) => {
        setCachedEnquiries(weddingId, items);
        return undefined;
      })
      .finally(() => inflight.delete(weddingId));
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetEnquiriesCache(): void {
  cache.clear();
  inflight.clear();
}
