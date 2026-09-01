// A `weddingId`-keyed cache for the organiser's guest list — the sibling of
// `events-store.ts`, and the second half of the P-I3 fetch-lift.
//
// Why this exists (P-I3, root Performance Backlog): the module shell renders each
// panel behind a `<Show>`, so navigating Guests ↔ Schedule unmounts and remounts
// `GuestTable` — a naive `onMount` fetch re-fires
// `GET /api/organiser/weddings/:weddingId/guests` on every return to Guests.
// `GuestTable` also over-fetched the full `/events` payload only to build an
// id→name chip map; with events already cached in `events-store`, that second
// fetch is gone. This module fetches a wedding's guest rows at most once and
// reuses the result across remounts, refetching only when the wedding changes or
// after a relevant mutation (an import apply) invalidates it.
//
// Effect is deliberately NOT imported here — this is frontend code (cire CLAUDE.md:
// "Effect is backend + DB only — never import it in cire/invites or cire/host").
// Plain Solid primitives only, matching `events-store.ts`.
import { type Accessor, createSignal, type Setter } from "solid-js";

/** One guest row as the organiser API returns it (repeats per family member —
 *  the table dedupes to households). */
export interface OrganiserGuestRow {
  /** The guest DB id (`guests.id`). Stable across renames — the editor draft
   *  (E5) keeps it so a first-name/nickname fix is an UPDATE, not remove+create
   *  (which would rotate nothing on guests but drop the guest's RSVPs). */
  guestId: string;
  familyId: string;
  publicId: string;
  familyName: string;
  firstName: string;
  lastName: string;
  /** Optional single-guest greeting name; `null` ⇒ use firstName. Carried so a
   *  draft-save preserves it instead of blanking it. */
  nickname: string | null;
  events: string[];
  codeSharedAt: number | null;
  firstOpenedAt: number | null;
  deactivatedAt: number | null;
}

interface CacheEntry {
  guests: Accessor<OrganiserGuestRow[] | null>;
  setGuests: Setter<OrganiserGuestRow[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [guests, setGuests] = createSignal<OrganiserGuestRow[] | null>(null);
    entry = { guests, setGuests };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** Reactive accessor for a wedding's cached guest rows (`null` until first load). */
export function guestsAccessor(weddingId: string): Accessor<OrganiserGuestRow[] | null> {
  return entryFor(weddingId).guests;
}

/** Has this wedding's guest list already been fetched in this session? When true
 *  a remounting `GuestTable` can skip the network round-trip entirely. */
export function hasCachedGuests(weddingId: string): boolean {
  return !stale.has(weddingId) && cache.get(weddingId)?.guests() != null;
}

/** Replace the cached guest rows for a wedding (used after a successful fetch or
 *  an in-place optimistic mutation that must survive a tab switch). */
export function setCachedGuests(weddingId: string, guests: OrganiserGuestRow[]): void {
  entryFor(weddingId).setGuests(guests);
}

/** Read the current cached rows without subscribing (for an in-place patch). */
export function peekCachedGuests(weddingId: string): OrganiserGuestRow[] | null {
  return cache.get(weddingId)?.guests() ?? null;
}

/** Drop a wedding's cached guest list so the next read refetches. Call after a
 *  mutation that can change the roster — e.g. an import apply. */
export function invalidateGuests(weddingId: string): void {
  // A mounted GuestTable is still rendering the last-known rows, and pulling
  // them out from under it for one round trip is the flicker this cache exists
  // to avoid — so the signal is left alone and the wedding is marked `stale`
  // instead. `hasCachedGuests` treats a stale id as a miss, which is what makes
  // the next `ensureGuestsLoaded` actually refetch rather than short-circuiting
  // on the (still-present) cached value.
  stale.add(weddingId);
  // A load already in flight was issued against PRE-mutation state, so its rows
  // describe state that has since been mutated: the wedding's GENERATION is
  // bumped too, and a resolving fetch from an older generation discards its
  // result instead of caching it. Without this, the editor's invalidate-then-
  // reload after a successful save can re-cache exactly the rows the organiser
  // just deleted.
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** Wedding ids whose cached rows are known out of date but still worth showing
 *  while the refetch is in flight. */
const stale = new Set<string>();

/** In-flight loads, keyed by weddingId, so two panels mounting in the same tick
 *  (e.g. GuestTable + Overview snapshot) share ONE fetch instead of racing two
 *  identical requests at the empty cache. */
const inflight = new Map<string, Promise<void>>();

/**
 * Load a wedding's guest rows into the cache exactly once. A cache hit returns
 * immediately; concurrent callers await the same in-flight fetch. `fetcher` is
 * caller-supplied so each panel keeps its own auth/redirect handling — a fetcher
 * that throws rejects every waiter and caches nothing (the next mount retries).
 */
export function ensureGuestsLoaded(
  weddingId: string,
  fetcher: () => Promise<OrganiserGuestRow[]>,
): Promise<void> {
  if (hasCachedGuests(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then(
        (rows) => {
          // A newer invalidation landed while this was in flight — its rows describe
          // state that has since been mutated, so drop them rather than cache them.
          if (generationOf(weddingId) !== startedAt) return;
          setCachedGuests(weddingId, rows);
          stale.delete(weddingId);
        },
        (err: unknown) => {
          // The refetch was refused or failed. The rows still on screen were
          // fetched under an authorisation this request could not confirm, so
          // they stop being shown: a demoted organiser must not keep reading
          // guest detail behind an error banner. Same generation guard — if a
          // newer invalidation has landed, a newer load owns the entry and this
          // one touches nothing.
          if (generationOf(weddingId) === startedAt) {
            entryFor(weddingId).setGuests(null);
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
export function __resetGuestsCache(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
  stale.clear();
}
