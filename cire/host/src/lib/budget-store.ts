// A `weddingId`-keyed cache for the organiser's budget — sibling of
// `tasks-store.ts`/`guests-store.ts`. Fetch-lift so switching modules doesn't
// refetch, and so the Overview budget widget + the Budget view share ONE fetch.
// Effect is deliberately NOT imported (frontend code). Money is minor units.
import { type Accessor, createSignal, type Setter } from "solid-js";

export interface BudgetItemRow {
  id: string;
  weddingId: string;
  category: string;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  notes: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentRow {
  id: string;
  budgetItemId: string;
  label: string;
  amountMinor: number;
  dueAt: string | null;
  paidAt: number | null;
  createdAt: number;
}

/** The whole budget as the organiser API returns it in one GET. */
export interface BudgetSnapshot {
  items: BudgetItemRow[];
  payments: PaymentRow[];
  budgetTotalMinor: number | null;
  currency: string;
}

interface CacheEntry {
  snapshot: Accessor<BudgetSnapshot | null>;
  setSnapshot: Setter<BudgetSnapshot | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [snapshot, setSnapshot] = createSignal<BudgetSnapshot | null>(null);
    entry = { snapshot, setSnapshot };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** The `actual ?? quoted ?? estimate ?? 0` spend rule — mirror of the server's
 *  computeRollup so an optimistic edit reflects instantly. */
export function itemSpend(item: BudgetItemRow): number {
  return item.actualMinor ?? item.quotedMinor ?? item.estimateMinor ?? 0;
}

export function budgetAccessor(weddingId: string): Accessor<BudgetSnapshot | null> {
  return entryFor(weddingId).snapshot;
}

export function hasCachedBudget(weddingId: string): boolean {
  return cache.get(weddingId)?.snapshot() != null;
}

export function setCachedBudget(weddingId: string, snapshot: BudgetSnapshot): void {
  entryFor(weddingId).setSnapshot(snapshot);
}

export function peekCachedBudget(weddingId: string): BudgetSnapshot | null {
  return cache.get(weddingId)?.snapshot() ?? null;
}

export function invalidateBudget(weddingId: string): void {
  cache.delete(weddingId);
}

/** Reactive spend-so-far for the Overview widget: `null` until first load. */
export function spentSoFar(weddingId: string): number | null {
  const snap = entryFor(weddingId).snapshot();
  if (snap == null) return null;
  return snap.items.reduce((sum, it) => sum + itemSpend(it), 0);
}

/** Unpaid payments, earliest `due_at` first (nulls last). Reactive; `[]` until
 *  load. The Overview flags overdue rows against today. */
export function upcomingPayments(weddingId: string): PaymentRow[] {
  const snap = entryFor(weddingId).snapshot();
  if (snap == null) return [];
  return snap.payments
    .filter((p) => p.paidAt == null)
    .sort((a, b) => {
      if (a.dueAt == null) return b.dueAt == null ? 0 : 1;
      if (b.dueAt == null) return -1;
      return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0;
    });
}

const inflight = new Map<string, Promise<void>>();

export function ensureBudgetLoaded(
  weddingId: string,
  fetcher: () => Promise<BudgetSnapshot>,
): Promise<void> {
  if (hasCachedBudget(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    pending = fetcher()
      .then((snap) => {
        setCachedBudget(weddingId, snap);
      })
      .finally(() => inflight.delete(weddingId));
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetBudgetCache(): void {
  cache.clear();
  inflight.clear();
}
