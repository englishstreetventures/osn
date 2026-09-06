// A `weddingId`-keyed cache for the organiser's HOUSEHOLD rows — the sibling of
// `guests-store.ts`, and the half of the roster the guest-shaped read can't see.
//
// Why this exists: `GET /guests` returns one row per GUEST, so a household that
// currently holds no guests produces no rows and is invisible to everything that
// groups guests into households — including the guest editor's draft. The draft
// is the whole truth for a save, so a household the editor never saw reads as a
// deletion and the next save removes it, taking a live claim code with it. The
// editor loads `GET /households` alongside the guests and carries the guest-less
// ones through, so they can be filled in or deliberately deleted.
//
// Effect is deliberately NOT imported here — this is frontend code (cire CLAUDE.md:
// "Effect is backend + DB only — never import it in cire/invites or cire/host").
import { type Accessor, createSignal, type Setter } from "solid-js";

/** One household row as the organiser API returns it (one per family, guest-less
 *  families included). */
export interface OrganiserHouseholdRow {
  familyId: string;
  publicId: string;
  familyName: string;
  /** Guests currently in the household — `0` for a code-only household. */
  guestCount: number;
  codeSharedAt: number | null;
  firstOpenedAt: number | null;
  deactivatedAt: number | null;
}

interface CacheEntry {
  households: Accessor<OrganiserHouseholdRow[] | null>;
  setHouseholds: Setter<OrganiserHouseholdRow[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [households, setHouseholds] = createSignal<OrganiserHouseholdRow[] | null>(null);
    entry = { households, setHouseholds };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** Reactive accessor for a wedding's cached households (`null` until loaded). */
export function householdsAccessor(weddingId: string): Accessor<OrganiserHouseholdRow[] | null> {
  return entryFor(weddingId).households;
}

/** Has this wedding's household list already been fetched in this session?
 *  Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function hasCachedHouseholds(weddingId: string): boolean {
  return !stale.has(weddingId) && cache.get(weddingId)?.households() != null;
}

/** Drop a wedding's cached households so the next read refetches. Call after a
 *  mutation that can change the roster — e.g. a change apply. */
export function invalidateHouseholds(weddingId: string): void {
  // A mounted editor is still rendering the last-known rows, and pulling them
  // out from under it for one round trip is the flicker this cache exists to
  // avoid — so the signal is left alone and the wedding is marked `stale`
  // instead. `hasCachedHouseholds` treats a stale id as a miss, which is what
  // makes the next `ensureHouseholdsLoaded` actually refetch rather than
  // short-circuiting on the (still-present) cached value.
  stale.add(weddingId);
  // A load already in flight was issued against PRE-mutation state, so its rows
  // describe state that has since been mutated: the wedding's GENERATION is
  // bumped too, and a resolving fetch from an older generation discards its
  // result instead of caching it. Without this, the editor's invalidate-then-
  // reload after a successful save can re-cache exactly the household the
  // organiser just deleted. Dropping the in-flight slot here (not just
  // bumping the generation) means the next `ensureHouseholdsLoaded` does not
  // join that doomed fetch — it starts a new one, at the cost of one extra
  // request. That is the right trade: joining would await a promise whose
  // result the generation guard is about to discard, leaving the caller with
  // `false` and the view unrefreshed until whatever call comes next.
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** Wedding ids whose cached rows are known out of date but still worth showing
 *  while the refetch is in flight. */
const stale = new Set<string>();

/** In-flight loads, keyed by weddingId, so concurrent mounts share ONE fetch. */
const inflight = new Map<string, Promise<boolean>>();

/**
 * Load a wedding's households into the cache exactly once. A cache hit returns
 * immediately; concurrent callers await the same in-flight fetch. `fetcher` is
 * caller-supplied so each panel keeps its own auth/redirect handling — a fetcher
 * that throws rejects every waiter and caches nothing (the next mount retries).
 */
export function ensureHouseholdsLoaded(
  weddingId: string,
  fetcher: () => Promise<OrganiserHouseholdRow[]>,
): Promise<boolean> {
  if (hasCachedHouseholds(weddingId)) return Promise.resolve(true);
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then(
        (rows) => {
          // A newer invalidation landed while this was in flight — its rows describe
          // state that has since been mutated, so drop them rather than cache them.
          if (generationOf(weddingId) !== startedAt) return false;
          entryFor(weddingId).setHouseholds(rows);
          stale.delete(weddingId);
          return true;
        },
        (err: unknown) => {
          // The refetch was refused or failed. The rows still on screen were
          // fetched under an authorisation this request could not confirm, so
          // they stop being shown: a demoted organiser must not keep reading
          // household detail behind an error banner. Same generation guard — if
          // a newer invalidation has landed, a newer load owns the entry and
          // this one touches nothing.
          if (generationOf(weddingId) === startedAt) {
            entryFor(weddingId).setHouseholds(null);
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
export function __resetHouseholdsCache(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
  stale.clear();
}
