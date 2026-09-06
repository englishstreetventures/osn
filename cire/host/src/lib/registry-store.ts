// A `weddingId`-keyed cache for the organiser's gift registry — sibling of
// `vendors-store.ts`/`budget-store.ts`. Fetch-lift so switching modules doesn't
// refetch, and so the two registry sub-views (the gift list and the gift log)
// share ONE fetch. Effect is deliberately NOT imported (frontend code).
// Timestamps are ms-epoch numbers; money is minor units.
//
// This caches the WHOLE snapshot rather than the item list, because one GET
// answers with the settings, the items, the first page of the gift log and the
// wedding's primary currency together. Splitting them into separate caches here
// would mean three entries fed by one response, and a partial invalidation would
// then be able to leave the item list and the gift log disagreeing about which
// response they came from.
import { type Accessor, createSignal, type Setter } from "solid-js";

/** Registry-level settings. The portal reads these; the Stripe fields are
 *  reported by the server and never written from here. */
export interface RegistrySettings {
  weddingId: string;
  published: boolean;
  headline: string | null;
  message: string | null;
  cashGiftsEnabled: boolean;
  shippingAddress: string | null;
  shippingVisibleFrom: string | null;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  updatedAt: number | null;
}

/** One gift-list row. `priceMinor` is denominated in the WEDDING's primary
 *  currency by definition — an item carries no currency of its own. */
export interface RegistryItem {
  id: string;
  weddingId: string;
  kind: "product" | "cash_fund";
  title: string;
  description: string | null;
  imageKey: string | null;
  imageCrop: string | null;
  externalUrl: string | null;
  priceMinor: number | null;
  quantityWanted: number;
  /** Sum of non-released claim quantities. Derived server-side, never stored. */
  quantityClaimed: number;
  allowPartial: boolean;
  targetMinor: number | null;
  category: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * One row of the gift log — a claim or a contribution, flattened.
 *
 * `amountMinor`/`currency` are AS GIVEN. `primaryAmountMinor`/`primaryCurrency`
 * are non-null ONLY when the gift arrived in some other currency, so the view
 * shows the as-given figure as the headline with the primary line underneath.
 *
 * `note`, `displayName` and `familyName` are GUEST-AUTHORED. Every renderer must
 * put them in a text node (S-L3).
 */
export interface GiftLogEntry {
  kind: "claim" | "contribution";
  id: string;
  itemId: string | null;
  itemTitle: string | null;
  familyId: string;
  familyName: string;
  displayName: string | null;
  /** Claims only. */
  quantity: number | null;
  status: string;
  note: string | null;
  amountMinor: number | null;
  currency: string | null;
  primaryAmountMinor: number | null;
  primaryCurrency: string | null;
  fxRate: string | null;
  thankedAt: number | null;
  createdAt: number;
}

/** The whole registry as the organiser API returns it in one GET. */
export interface RegistrySnapshot {
  settings: RegistrySettings;
  items: RegistryItem[];
  gifts: GiftLogEntry[];
  /** Whether another page of gift-log rows sits past `gifts`. */
  giftsHasMore: boolean;
  /** The wedding's primary currency — what every authored figure is in. */
  currency: string;
  /** Succeeded contributions summed in the primary currency. APPROXIMATE by
   *  construction (each foreign row converted at its own snapshotted rate), so
   *  the view must label it as such. */
  contributionsPrimaryMinor: number;
}

interface CacheEntry {
  snapshot: Accessor<RegistrySnapshot | null>;
  setSnapshot: Setter<RegistrySnapshot | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [snapshot, setSnapshot] = createSignal<RegistrySnapshot | null>(null);
    entry = { snapshot, setSnapshot };
    cache.set(weddingId, entry);
  }
  return entry;
}

export function registryAccessor(weddingId: string): Accessor<RegistrySnapshot | null> {
  return entryFor(weddingId).snapshot;
}

export function hasCachedRegistry(weddingId: string): boolean {
  return cache.get(weddingId)?.snapshot() != null;
}

export function setCachedRegistry(weddingId: string, snapshot: RegistrySnapshot): void {
  entryFor(weddingId).setSnapshot(snapshot);
}

export function peekCachedRegistry(weddingId: string): RegistrySnapshot | null {
  return cache.get(weddingId)?.snapshot() ?? null;
}

/**
 * Drop the cached snapshot, keeping the SIGNAL.
 *
 * Deleting the map entry would mint a fresh signal on the next `entryFor`, and
 * every view that captured the old accessor at mount would then read a signal
 * nothing writes to again — a dead view with stale content. This was the
 * repo-wide `P-W2` in `[[cire/wiki/todo/perf]]`; every sibling cache
 * (`vendors-store`, `budget-store`, `tasks-store`, `enquiries-store`,
 * `events-store`, `guests-store`, `households-store`) now notifies the same
 * way.
 *
 * A load already in flight was issued against PRE-invalidation state, so its
 * snapshot is stale the moment this runs. Clearing the signal alone is not
 * enough — the fetch's own `.then` would still write it in AFTER this call —
 * so the wedding's GENERATION is bumped too, and a resolving fetch from an
 * older generation discards its result instead of caching it.
 */
export function invalidateRegistry(weddingId: string): void {
  entryFor(weddingId).setSnapshot(null);
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** How many of an item's wanted quantity are still unspoken for. Never negative
 *  — a race can land one claim past the wanted count, and a negative "still
 *  wanted" reads as a fault rather than as "fully claimed". */
export function stillWanted(item: RegistryItem): number {
  return Math.max(0, item.quantityWanted - item.quantityClaimed);
}

const inflight = new Map<string, Promise<void>>();

export function ensureRegistryLoaded(
  weddingId: string,
  fetcher: () => Promise<RegistrySnapshot>,
): Promise<void> {
  if (hasCachedRegistry(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then((snap) => {
        // A newer invalidation landed while this was in flight — its snapshot
        // describes state that has since been mutated, so drop it rather than
        // cache it.
        if (generationOf(weddingId) !== startedAt) return;
        setCachedRegistry(weddingId, snap);
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
export function __resetRegistryCache(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
}
