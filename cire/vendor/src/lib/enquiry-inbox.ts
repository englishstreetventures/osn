// The vendor's enquiry inbox, a page at a time. The dashboard makes one holder
// and hands it to the inbox, so a vendor back from a thread is shown as many
// pages as they had loaded — the inbox itself unmounts while a thread is open.
import { type Accessor, createSignal } from "solid-js";

import type { VendorEnquiryListItem, VendorEnquiryPage } from "./enquiries-store";

export interface EnquiryInbox {
  /** The rows loaded so far, newest first; `null` until page one arrives, and after a failed read. */
  rows: Accessor<VendorEnquiryListItem[] | null>;
  /** Continues after the last loaded row; `null` once every page is loaded. */
  nextCursor: Accessor<string | null>;
  /** The last read failed and the inbox was cleared. */
  failed: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  /** Read the inbox again, as many pages as are held — on every mount of the inbox. */
  refresh: () => Promise<void>;
  /** Read the page after the last loaded row. Does nothing with no next page or nothing loaded. */
  loadMore: () => Promise<void>;
}

/**
 * The inbox order: newest message first, and on a tie the greater id first —
 * the API's `last_message_at DESC, id DESC`, so merged pages sit where the API
 * would have put them.
 */
function byNewestFirst(a: VendorEnquiryListItem, b: VendorEnquiryListItem): number {
  return b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * `held` with `arrived` merged in: one row per enquiry, the arrived copy
 * winning, in inbox order. Both are already in inbox order — every list held
 * here came from the API or from this merge — so one pass interleaves them.
 */
function merge(
  held: readonly VendorEnquiryListItem[],
  arrived: readonly VendorEnquiryListItem[],
): VendorEnquiryListItem[] {
  const fresh = new Set(arrived.map((r) => r.id));
  const kept = held.filter((r) => !fresh.has(r.id));
  const out: VendorEnquiryListItem[] = [];
  let i = 0;
  let j = 0;
  while (i < kept.length && j < arrived.length) {
    out.push(byNewestFirst(kept[i]!, arrived[j]!) <= 0 ? kept[i++]! : arrived[j++]!);
  }
  return out.concat(kept.slice(i), arrived.slice(j));
}

/**
 * Every row shown comes from an answer the API gave after the vendor's latest
 * access check. A re-read on mount reads again as many pages as are held and
 * replaces them, so a vendor back from a thread keeps their place, and a row
 * that has left their organisations or belongs to a deleted wedding drops out;
 * the held rows stay on screen while it runs. A failed read, of page one or of
 * a next page, clears the inbox: the client cannot tell a dropped connection
 * from a refusal it has to honour.
 */
export function createEnquiryInbox(
  fetchPage: (cursor?: string) => Promise<VendorEnquiryPage>,
): EnquiryInbox {
  const [rows, setRows] = createSignal<VendorEnquiryListItem[] | null>(null);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  /** Pages behind the rows shown. */
  let pagesHeld = 0;
  /** Bumped by each re-read; an answer to a request made before it is dropped. */
  let generation = 0;

  function clear(): void {
    setRows(null);
    setNextCursor(null);
    pagesHeld = 0;
    setFailed(true);
  }

  async function refresh(): Promise<void> {
    const started = ++generation;
    const want = Math.max(1, pagesHeld);
    setFailed(false);
    let read: VendorEnquiryListItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    try {
      do {
        // Sequential by nature: each page's cursor comes from the one before.
        // eslint-disable-next-line no-await-in-loop
        const page = await fetchPage(cursor ?? undefined);
        if (started !== generation) return;
        read = merge(read, page.enquiries);
        cursor = page.nextCursor;
        pages++;
      } while (cursor !== null && pages < want);
      setRows(read);
      setNextCursor(cursor);
      pagesHeld = pages;
    } catch {
      if (started === generation) clear();
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor();
    const held = rows();
    if (cursor === null || held === null || loadingMore()) return;
    const started = generation;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      if (started !== generation) return;
      setRows(merge(rows() ?? held, page.enquiries));
      setNextCursor(page.nextCursor);
      pagesHeld++;
    } catch {
      if (started === generation) clear();
    } finally {
      setLoadingMore(false);
    }
  }

  return { rows, nextCursor, failed, loadingMore, refresh, loadMore };
}
