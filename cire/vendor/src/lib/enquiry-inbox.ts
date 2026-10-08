// The vendor's enquiry inbox, a page at a time. The dashboard makes one holder
// and hands it to the inbox, so the pages a vendor has loaded are still there
// when they come back from a thread — the inbox itself unmounts while a thread
// is open.
import { type Accessor, createSignal } from "solid-js";

import type { VendorEnquiryListItem, VendorEnquiryPage } from "./enquiries-store";

export interface EnquiryInbox {
  /** The rows loaded so far, newest first; `null` until page one arrives, and after it fails. */
  rows: Accessor<VendorEnquiryListItem[] | null>;
  /** Continues after the last loaded row; `null` once every page is loaded. */
  nextCursor: Accessor<string | null>;
  /** Page one could not be read. */
  failed: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  /** The last next-page request failed; the rows already shown stay. */
  moreFailed: Accessor<boolean>;
  /** Read page one again — on every mount of the inbox. */
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
 * Re-reading page one keeps deeper pages: a vendor who loaded three pages,
 * opened a thread and came back still has all three, with page one's rows
 * fresh (a quote just sent moves its row to the top). When page one says it is
 * the whole inbox, or nothing beyond it is held, it replaces what is held, so
 * an empty answer (the vendor has left the organisation) empties the inbox.
 */
export function createEnquiryInbox(
  fetchPage: (cursor?: string) => Promise<VendorEnquiryPage>,
): EnquiryInbox {
  const [rows, setRows] = createSignal<VendorEnquiryListItem[] | null>(null);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [moreFailed, setMoreFailed] = createSignal(false);
  /** Whether the rows hold more than page one. */
  let beyondPageOne = false;
  /** Bumped by each read of page one; a next page asked for before it is dropped. */
  let generation = 0;

  async function refresh(): Promise<void> {
    const started = ++generation;
    setFailed(false);
    setMoreFailed(false);
    try {
      const page = await fetchPage();
      if (started !== generation) return;
      const held = rows();
      if (held === null || !beyondPageOne || page.nextCursor === null) {
        setRows(page.enquiries);
        setNextCursor(page.nextCursor);
        beyondPageOne = false;
      } else {
        setRows(merge(held, page.enquiries));
      }
    } catch {
      if (started !== generation) return;
      setRows(null);
      setNextCursor(null);
      beyondPageOne = false;
      setFailed(true);
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor();
    const held = rows();
    if (cursor === null || held === null || loadingMore()) return;
    const started = generation;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await fetchPage(cursor);
      if (started !== generation) return;
      setRows(merge(rows() ?? held, page.enquiries));
      setNextCursor(page.nextCursor);
      beyondPageOne = true;
    } catch {
      if (started === generation) setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return { rows, nextCursor, failed, loadingMore, moreFailed, refresh, loadMore };
}
