// A `weddingId`-keyed cache for the organiser's checklist tasks — the sibling of
// `guests-store.ts`/`events-store.ts`. Same fetch-lift so switching modules
// doesn't refetch, and so the Overview "open tasks" widget and the Checklist
// view share ONE fetch. Effect is deliberately NOT imported (frontend code).
import { type Accessor, createSignal, type Setter } from "solid-js";

/** One task row as the organiser API returns it (timestamps are ms-epoch numbers). */
export interface TaskRow {
  id: string;
  weddingId: string;
  title: string;
  notes: string | null;
  timeframeBucket: string;
  dueAt: string | null;
  status: "open" | "done";
  sortOrder: number;
  createdAt: number;
  completedAt: number | null;
}

interface CacheEntry {
  tasks: Accessor<TaskRow[] | null>;
  setTasks: Setter<TaskRow[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [tasks, setTasks] = createSignal<TaskRow[] | null>(null);
    entry = { tasks, setTasks };
    cache.set(weddingId, entry);
  }
  return entry;
}

export function tasksAccessor(weddingId: string): Accessor<TaskRow[] | null> {
  return entryFor(weddingId).tasks;
}

export function hasCachedTasks(weddingId: string): boolean {
  return !stale.has(weddingId) && cache.get(weddingId)?.tasks() != null;
}

export function setCachedTasks(weddingId: string, tasks: TaskRow[]): void {
  entryFor(weddingId).setTasks(tasks);
}

export function peekCachedTasks(weddingId: string): TaskRow[] | null {
  return cache.get(weddingId)?.tasks() ?? null;
}

export function invalidateTasks(weddingId: string): void {
  // A mounted Checklist view is still rendering the last-known rows, and
  // pulling them out from under it for one round trip is the flicker this
  // cache exists to avoid — so the signal is left alone and the wedding is
  // marked `stale` instead. `hasCachedTasks` treats a stale id as a miss,
  // which is what makes the next `ensureTasksLoaded` actually refetch rather
  // than short-circuiting on the (still-present) cached value.
  stale.add(weddingId);
  // A load already in flight was issued against PRE-mutation state, so its
  // rows describe state that has since been mutated: the wedding's
  // GENERATION is bumped too, and a resolving fetch from an older generation
  // discards its result instead of caching it.
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** Wedding ids whose cached rows are known out of date but still worth showing
 *  while the refetch is in flight. */
const stale = new Set<string>();

/** Reactive open-task count for the Overview widget: `null` until first load.
 *  Reads without allocating a dangling signal for a never-loaded weddingId. */
export function openTaskCount(weddingId: string): number | null {
  const rows = cache.get(weddingId)?.tasks() ?? null;
  if (rows == null) return null;
  return rows.filter((t) => t.status === "open").length;
}

/** Reactive open/done/total counts for the Overview completion bar: `null` until
 *  first load. Reads without allocating a dangling signal for a never-loaded
 *  weddingId (mirrors {@link openTaskCount}). */
export function taskCounts(
  weddingId: string,
): { open: number; done: number; total: number } | null {
  const rows = cache.get(weddingId)?.tasks() ?? null;
  if (rows == null) return null;
  let open = 0;
  let done = 0;
  for (const t of rows) {
    if (t.status === "open") open += 1;
    else if (t.status === "done") done += 1;
  }
  return { open, done, total: rows.length };
}

const inflight = new Map<string, Promise<void>>();

export function ensureTasksLoaded(
  weddingId: string,
  fetcher: () => Promise<TaskRow[]>,
): Promise<void> {
  if (hasCachedTasks(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then(
        (rows) => {
          // A newer invalidation landed while this was in flight — its rows
          // describe state that has since been mutated, so drop them rather than
          // cache them.
          if (generationOf(weddingId) !== startedAt) return;
          setCachedTasks(weddingId, rows);
          stale.delete(weddingId);
        },
        (err: unknown) => {
          // The refetch was refused or failed. The rows still on screen were
          // fetched under an authorisation this request could not confirm, so
          // they stop being shown: a demoted organiser must not keep reading
          // checklist detail behind an error banner. Same generation guard —
          // if a newer invalidation has landed, a newer load owns the entry
          // and this one touches nothing.
          if (generationOf(weddingId) === startedAt) {
            entryFor(weddingId).setTasks(null);
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
export function __resetTasksCache(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
  stale.clear();
}
