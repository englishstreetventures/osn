// A small `weddingId`-keyed cache for the organiser's events list.
//
// Why this exists: the dashboard tabs (`DashboardTabs.tsx`) render each panel
// behind a `<Show>`, so switching Guests ↔ Events unmounts and remounts
// `EventTable` — and a naive `onMount` fetch re-fires the
// `GET /api/organiser/weddings/:weddingId/events` request on every flip back to
// Events. This module fetches a wedding's events at most once and reuses the
// result across remounts, refetching only when the wedding changes or after a
// relevant mutation (an import apply) invalidates it.
//
// Implementation: a module-scoped `Map` keyed by `weddingId`, each entry a Solid
// signal so reads are reactive (a background revalidation or an in-place image
// patch updates every live `EventTable`). The cache is intentionally
// module-scoped — it outlives any single `EventTable` mount, which is exactly
// what dedupes the fetch across tab switches. Different weddings never share an
// entry, so there is no cross-wedding leakage.
//
// Effect is deliberately NOT imported here — this is frontend code (see the cire
// CLAUDE.md: "Effect is backend + DB only — never import it in cire/web or
// cire/organiser"). Plain Solid primitives only.
import { type Accessor, createSignal, type Setter } from "solid-js";

import type { ImageCrop } from "./image-crop";

export interface DressSwatch {
  name: string;
  color: string;
}

export interface EventRow {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  startAt: string;
  endAt: string;
  timezone: string;
  address: string | null;
  description: string;
  dressCodeDescription: string | null;
  dressCodePalette: DressSwatch[] | null;
  pinterestUrl: string | null;
  mapsUrl: string | null;
  /** First-party path to this event's optional image (or null). API-origin
   * relative — prepend `apiUrl()` before use. */
  imageUrl: string | null;
  /** Normalised crop rectangle the guest site applies (or null for the default
   * centre crop). */
  imageCrop: ImageCrop | null;
  /** Planning-only location (organiser dashboard; never on the invite).
   * Event-scoped — a wedding can span countries. Both halves set or both null. */
  locationLat: number | null;
  locationLng: number | null;
  /** Pricing-region key (closed enum, validated server-side) or null. */
  pricingRegion: string | null;
}

/** A cached wedding's events plus the setter the owning `EventTable` uses to
 *  patch rows in place (image upload/remove/crop) so those edits survive a tab
 *  switch without a refetch. `null` events means "not loaded yet". */
interface CacheEntry {
  events: Accessor<EventRow[] | null>;
  setEvents: Setter<EventRow[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [events, setEvents] = createSignal<EventRow[] | null>(null);
    entry = { events, setEvents };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** Reactive accessor for a wedding's cached events (`null` until first load). */
export function eventsAccessor(weddingId: string): Accessor<EventRow[] | null> {
  return entryFor(weddingId).events;
}

/** Has this wedding's events already been fetched in this session? When true a
 *  remounting `EventTable` can skip the network round-trip entirely. */
export function hasCachedEvents(weddingId: string): boolean {
  return cache.get(weddingId)?.events() != null;
}

/** Replace the cached events for a wedding (used after a successful fetch). */
export function setCachedEvents(weddingId: string, events: EventRow[]): void {
  entryFor(weddingId).setEvents(events);
}

/** Patch a single row in place (image upload/remove/crop). A no-op if the
 *  wedding isn't cached yet. */
export function patchCachedEvent(
  weddingId: string,
  eventId: string,
  patch: Partial<EventRow>,
): void {
  const entry = cache.get(weddingId);
  if (!entry) return;
  entry.setEvents((rows) =>
    rows == null ? rows : rows.map((r) => (r.id === eventId ? { ...r, ...patch } : r)),
  );
}

/** Drop a wedding's cached events so the next read refetches. Call after a
 *  mutation that can change the event list — e.g. an import apply. */
export function invalidateEvents(weddingId: string): void {
  cache.delete(weddingId);
}

/** In-flight loads, keyed by weddingId, so two panels mounting in the same
 *  tick (EventTable + EventLocationsPanel on the Events tab) share ONE fetch
 *  instead of racing two identical requests at the empty cache. */
const inflight = new Map<string, Promise<void>>();

/**
 * Load a wedding's events into the cache exactly once. A cache hit returns
 * immediately; concurrent callers await the same in-flight fetch. `fetcher`
 * is caller-supplied so each panel keeps its own auth/redirect handling — a
 * fetcher that throws rejects every waiter and caches nothing (the next mount
 * retries).
 */
export function ensureEventsLoaded(
  weddingId: string,
  fetcher: () => Promise<EventRow[]>,
): Promise<void> {
  if (hasCachedEvents(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    pending = fetcher()
      .then((rows) => {
        setCachedEvents(weddingId, rows);
      })
      .finally(() => inflight.delete(weddingId));
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetEventsCache(): void {
  cache.clear();
  inflight.clear();
}
