// A `weddingId`-keyed cache for the organiser's enquiry inbox — sibling of
// `vendors-store.ts`/`budget-store.ts`. Fetch-lift so switching modules doesn't
// refetch. The inbox arrives a page at a time, newest first: the cache holds the
// pages loaded so far and the cursor that continues after them. Effect is
// deliberately NOT imported (frontend code). Timestamps are ms-epoch numbers.
import { type Accessor, createSignal, type Setter } from "solid-js";

import { isWeddingClosed } from "./wedding-scope";

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

/** One page of the inbox. `nextCursor` continues after its last row; `null` on the last page. */
export interface EnquiryPage {
  enquiries: EnquiryListItem[];
  nextCursor: string | null;
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
  /** Continues after the last loaded row; `null` once every page is loaded. */
  nextCursor: Accessor<string | null>;
  setNextCursor: Setter<string | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [enquiries, setEnquiries] = createSignal<EnquiryListItem[] | null>(null);
    const [nextCursor, setNextCursor] = createSignal<string | null>(null);
    entry = { enquiries, setEnquiries, nextCursor, setNextCursor };
    cache.set(weddingId, entry);
  }
  return entry;
}

/**
 * The inbox order: newest message first, and on a tie the greater id first —
 * the server's `last_message_at DESC, id DESC`, so pages merged here sit where
 * the server would have put them.
 */
export function byNewestFirst(a: EnquiryListItem, b: EnquiryListItem): number {
  return b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** The cursor for the next page, or `null` when the inbox is fully loaded (or not loaded). */
export function enquiriesNextCursor(weddingId: string): Accessor<string | null> {
  return entryFor(weddingId).nextCursor;
}

export function enquiriesAccessor(weddingId: string): Accessor<EnquiryListItem[] | null> {
  return entryFor(weddingId).enquiries;
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function hasCachedEnquiries(weddingId: string): boolean {
  return !stale.has(weddingId) && cache.get(weddingId)?.enquiries() != null;
}

export function setCachedEnquiries(weddingId: string, items: EnquiryListItem[]): void {
  if (isWeddingClosed(weddingId)) return;
  entryFor(weddingId).setEnquiries(items);
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function peekCachedEnquiries(weddingId: string): EnquiryListItem[] | null {
  return cache.get(weddingId)?.enquiries() ?? null;
}

export function invalidateEnquiries(weddingId: string): void {
  // A mounted inbox is still rendering the last-known rows, and pulling them
  // out from under it for one round trip is the flicker this cache exists to
  // avoid — so the signal is left alone and the wedding is marked `stale`
  // instead. `hasCachedEnquiries` treats a stale id as a miss, which is what
  // makes the next `ensureEnquiriesLoaded` actually refetch rather than
  // short-circuiting on the (still-present) cached value.
  stale.add(weddingId);
  // A load already in flight was issued against PRE-mutation state, so its
  // rows describe state that has since been mutated: the wedding's GENERATION
  // is bumped too, and a resolving fetch from an older generation discards its
  // result instead of caching it. Dropping the in-flight slot here (not just
  // bumping the generation) means the next `ensureEnquiriesLoaded` does not
  // join that doomed fetch — it starts a new one, at the cost of one extra
  // request. That is the right trade: joining would await a promise whose
  // result the generation guard is about to discard, leaving the caller with
  // `false` and the view unrefreshed until whatever call comes next.
  inflight.delete(weddingId);
  moreInflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** Wedding ids whose cached rows are known out of date but still worth showing
 *  while the refetch is in flight. */
const stale = new Set<string>();

export function upsertCachedEnquiry(weddingId: string, next: EnquiryListItem): void {
  const cur = peekCachedEnquiries(weddingId);
  // `null` is "not loaded", not "no rows". Writing a one-row list here would both
  // hide the rest and flip `hasCachedEnquiries` to true, suppressing the refetch
  // that would have restored them.
  if (cur == null) return;
  const without = cur.filter((e) => e.id !== next.id);
  setCachedEnquiries(weddingId, [next, ...without].toSorted(byNewestFirst));
}

const inflight = new Map<string, Promise<boolean>>();
const moreInflight = new Map<string, Promise<boolean>>();

/** Page one: the rows, and the cursor that continues after them. */
export function ensureEnquiriesLoaded(
  weddingId: string,
  fetcher: () => Promise<EnquiryPage>,
): Promise<boolean> {
  // A closed wedding loads nothing: the caller is a view that has already
  // been torn down.
  if (isWeddingClosed(weddingId)) return Promise.resolve(false);
  if (hasCachedEnquiries(weddingId)) return Promise.resolve(true);
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then(
        (page) => {
          // A newer invalidation landed while this was in flight — its rows
          // describe state that has since been mutated, so drop them rather than
          // cache them.
          if (generationOf(weddingId) !== startedAt) return false;
          setCachedEnquiries(weddingId, page.enquiries);
          entryFor(weddingId).setNextCursor(page.nextCursor);
          stale.delete(weddingId);
          return true;
        },
        (err: unknown) => {
          // The refetch was refused or failed. The rows still on screen were
          // fetched under an authorisation this request could not confirm, so
          // they stop being shown: a demoted organiser must not keep reading
          // enquiry detail behind an error banner. Same generation guard — if a
          // newer invalidation has landed, a newer load owns the entry and this
          // one touches nothing.
          if (generationOf(weddingId) === startedAt) blank(weddingId);
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

/** A refused load's outcome: no rows shown, no page to continue from. */
function blank(weddingId: string): void {
  const entry = entryFor(weddingId);
  entry.setEnquiries(null);
  entry.setNextCursor(null);
  stale.delete(weddingId);
}

/**
 * The next page, merged into the rows already loaded. Resolves `false`, and
 * fetches nothing, when there is no next page, nothing is loaded yet, the
 * wedding is closed, or page one is being read again: a page fetched from the
 * old cursor would land after the new page one with the rows between them
 * missing.
 *
 * The page is merged into the rows as they are when it ARRIVES, so a row
 * written meanwhile (a reply, a new enquiry) survives; where the page and the
 * cache hold the same enquiry, the page's copy wins, and the result is put in
 * {@link byNewestFirst} order.
 *
 * Fetching the next page is a server check like the refetch in
 * {@link ensureEnquiriesLoaded}, so a refusal blanks the rows the same way and
 * rethrows: an organiser who has lost access stops seeing the inbox. Both
 * outcomes are dropped when an invalidation or a drop lands first.
 */
export function loadMoreEnquiries(
  weddingId: string,
  fetcher: (cursor: string) => Promise<EnquiryPage>,
): Promise<boolean> {
  if (isWeddingClosed(weddingId)) return Promise.resolve(false);
  if (stale.has(weddingId) || inflight.has(weddingId)) return Promise.resolve(false);
  const entry = entryFor(weddingId);
  const cursor = entry.nextCursor();
  if (cursor === null || entry.enquiries() === null) return Promise.resolve(false);
  let pending = moreInflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher(cursor)
      .then(
        (page) => {
          if (generationOf(weddingId) !== startedAt) return false;
          const current = peekCachedEnquiries(weddingId);
          if (current === null) return false;
          const arrived = new Set(page.enquiries.map((e) => e.id));
          setCachedEnquiries(
            weddingId,
            [...current.filter((e) => !arrived.has(e.id)), ...page.enquiries].toSorted(
              byNewestFirst,
            ),
          );
          entryFor(weddingId).setNextCursor(page.nextCursor);
          return true;
        },
        (err: unknown) => {
          if (generationOf(weddingId) === startedAt) blank(weddingId);
          throw err;
        },
      )
      .finally(() => {
        if (moreInflight.get(weddingId) === load) moreInflight.delete(weddingId);
      });
    pending = load;
    moreInflight.set(weddingId, pending);
  }
  return pending;
}

/**
 * Forget a wedding: release its rows and cursor, drop its in-flight slots, and bump its
 * generation so a load still in flight discards what it fetches. A view still
 * holding the old accessor reads `null` from then on. The generation is bumped
 * rather than deleted, because a deleted one reads as 0 — the same value an
 * old load captured — and that load would then cache what it fetched.
 */
export function dropEnquiries(weddingId: string): void {
  cache.get(weddingId)?.setEnquiries(null);
  cache.get(weddingId)?.setNextCursor(null);
  cache.delete(weddingId);
  inflight.delete(weddingId);
  moreInflight.delete(weddingId);
  stale.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetEnquiriesCache(): void {
  cache.clear();
  inflight.clear();
  moreInflight.clear();
  generation.clear();
  stale.clear();
}
