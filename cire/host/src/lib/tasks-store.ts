// A `weddingId`-keyed cache for the organiser's checklist tasks — the sibling of
// `guests-store.ts`/`events-store.ts`. Same fetch-lift so switching modules
// doesn't refetch, and so the Overview "open tasks" widget and the Checklist
// view share ONE fetch. Effect is deliberately NOT imported (frontend code).
//
// The cache itself is a `createRereadCache` (`reread-cache.ts`): the coalescing
// re-read, the generation guard and the rule that no read lands across one of
// the portal's own task writes all live there, shared with the run sheet,
// whose rows the same writes change. The writes are counted by `taskWrites`.
import { type Accessor, createSignal, type Setter } from "solid-js";

import { createRereadCache } from "./reread-cache";
import { taskWrites } from "./task-writes";
import { isWeddingClosed } from "./wedding-scope";

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
  /** The seats (`hostId` in `GET …/hosts`) holding the task, in the order they
   *  were put on it; empty for nobody. */
  assigneeHostIds: string[];
  // ── The task's time on the day ─────────────────────────────────────────────
  // Every answer from an API that has run times carries all six. An older API
  // sends none, and the row keeps none: absent reads as untimed (`?? null`).
  // Left absent rather than filled in, so a row keeps the same keys however it
  // reached the cache — the checklist's row memo compares them.
  /** When the task runs, `YYYY-MM-DDTHH:MM:SS±HH:MM`; for a task linked to an
   *  event, the event's start moved by `runOffsetMinutes`. */
  runAt?: string | null;
  /** The zone `runAt` is read in — the event's, for a linked task. */
  runTimezone?: string | null;
  /** The event the task is linked to. */
  eventId?: string | null;
  /** Minutes from the linked event's start, negative before it. */
  runOffsetMinutes?: number | null;
  /** The time follows the linked event. */
  anchored?: boolean;
  /** The task's event was removed by a schedule change; it kept its time. */
  eventRemoved?: boolean;
}

/**
 * A task as either API release sends it. The API before holders names one
 * `assignedHostId` and no `assigneeHostIds`, and a release can put this portal
 * in front of it, so every answer the portal reads goes through
 * {@link readTaskRow}. Read until englishstreetventures/osn#1636 drops the
 * column that API reads; no API that sends the old shape can serve after it.
 */
export type TaskWire = Omit<TaskRow, "assigneeHostIds"> & {
  assigneeHostIds?: string[];
  assignedHostId?: string | null;
};

/** A task as the portal keeps it, from either shape: its `assigneeHostIds`,
 *  else the one `assignedHostId` as its only holder, else nobody. */
export function readTaskRow(task: TaskWire): TaskRow {
  const { assignedHostId, assigneeHostIds, ...rest } = task;
  return { ...rest, assigneeHostIds: assigneeHostIds ?? (assignedHostId ? [assignedHostId] : []) };
}

/** `GET …/tasks` as the API answers it. */
export interface TaskList {
  tasks: TaskWire[];
  /** The caller's own seat on the wedding. Absent from an API older than it. */
  viewerHostId?: string | null;
}

/** The checklist's rows, per wedding. The run sheet has its own cache. */
const cache = createRereadCache<TaskRow[]>({ writes: taskWrites, staleOnWriteEnd: false });

interface SeatEntry {
  seat: Accessor<string | null>;
  setSeat: Setter<string | null>;
}

/** The caller's own seat per wedding, as the last task read named it. */
const seats = new Map<string, SeatEntry>();

function seatFor(weddingId: string): SeatEntry {
  let entry = seats.get(weddingId);
  if (!entry) {
    const [seat, setSeat] = createSignal<string | null>(null);
    entry = { seat, setSeat };
    seats.set(weddingId, entry);
  }
  return entry;
}

export function tasksAccessor(weddingId: string): Accessor<TaskRow[] | null> {
  return cache.accessor(weddingId);
}

/**
 * Take a `GET …/tasks` answer apart: keep the caller's own seat id, which the
 * checklist puts first among a task's holders, and hand back the rows, read
 * through {@link readTaskRow}, for the loader to return. Every reader of the
 * list goes through here, so the seat is known whichever module read the tasks
 * first.
 */
export function readTaskList(weddingId: string, list: TaskList): TaskRow[] {
  if (!isWeddingClosed(weddingId)) seatFor(weddingId).setSeat(list.viewerHostId ?? null);
  return list.tasks.map(readTaskRow);
}

/** The caller's own seat on the wedding, as the last task read named it;
 *  `null` before one. Reactive, and subscribes from a cold cache too. */
export function viewerHostIdOf(weddingId: string): string | null {
  return seatFor(weddingId).seat();
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function hasCachedTasks(weddingId: string): boolean {
  return cache.has(weddingId);
}

export function setCachedTasks(weddingId: string, tasks: TaskRow[]): void {
  cache.setCached(weddingId, tasks);
}

/**
 * Replace the list with the whole list a write just answered with. It is the
 * newest read there is, so the wedding is fresh again, and the generation moves
 * on so a load already in flight — started before the write — discards what it
 * fetches instead of landing on top.
 */
export function setFreshTasks(weddingId: string, tasks: TaskRow[]): void {
  cache.setFresh(weddingId, tasks);
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function peekCachedTasks(weddingId: string): TaskRow[] | null {
  return cache.peek(weddingId);
}

/**
 * Mark the wedding's rows out of date without touching a read in flight: the
 * tab was told its tasks changed, but no view of them is open. The next view
 * to open reads again. A read already out still lands, and shows its rows, but
 * leaves the wedding stale, since it may predate what changed.
 */
export function markTasksStale(weddingId: string): void {
  cache.markStale(weddingId);
}

/**
 * Read the wedding's tasks again because a signal said they changed, from a
 * view that shows them. Signals coalesce: while a read is in flight, or one of
 * the portal's own writes is out, the read waits, and however many signals
 * arrive meanwhile, one read goes once the read in flight has landed and the
 * last write has ended. So a burst costs at most two reads, and the read that
 * shows always started after the last signal and after the tab's own writes.
 *
 * Settles as {@link ensureTasksLoaded} does once that read lands (with its
 * error when it failed), or `false` when the wedding was forgotten first.
 */
export function rereadTasks(
  weddingId: string,
  fetcher: () => Promise<TaskRow[]>,
): Promise<boolean> {
  return cache.reread(weddingId, fetcher);
}

/**
 * The wedding's rows are known out of date. A mounted Checklist view keeps
 * rendering the last-known rows rather than flickering for one round trip; the
 * next `ensureTasksLoaded` reads again, and a load already in flight —
 * issued against state that has since changed — discards what it fetches.
 */
export function invalidateTasks(weddingId: string): void {
  cache.invalidate(weddingId);
}

/**
 * Mark one of the portal's own task writes as out, and get back the function
 * that marks it done (calling it again does nothing).
 *
 * While any write is out, a read that lands is dropped and the wedding stays
 * stale, and a read sent before a write ends is dropped when it lands after:
 * the server may have answered it from before the write committed, and its
 * rows would undo what the organiser just did on screen. A dropped read is
 * sent again once the last write ends, as is a re-read a signal asked for
 * while one was out, so the read that sees the write always goes, whichever
 * reached the tab first, the write's answer or its signal. The run sheet's
 * cache follows the same writes.
 */
export function beginTaskWrite(weddingId: string): () => void {
  return taskWrites.begin(weddingId);
}

/** Reactive open-task count for the Overview widget: `null` until first load.
 *  Mints the wedding's cache entry so the read subscribes even from a cold
 *  cache. */
export function openTaskCount(weddingId: string): number | null {
  const rows = cache.accessor(weddingId)();
  if (rows == null) return null;
  return rows.filter((t) => t.status === "open").length;
}

/** Reactive open/done/total counts for the Overview completion bar: `null`
 *  until first load. Mints the wedding's cache entry so the read subscribes
 *  even from a cold cache (mirrors {@link openTaskCount}). */
export function taskCounts(
  weddingId: string,
): { open: number; done: number; total: number } | null {
  const rows = cache.accessor(weddingId)();
  if (rows == null) return null;
  let open = 0;
  let done = 0;
  for (const t of rows) {
    if (t.status === "open") open += 1;
    else if (t.status === "done") done += 1;
  }
  return { open, done, total: rows.length };
}

export function ensureTasksLoaded(
  weddingId: string,
  fetcher: () => Promise<TaskRow[]>,
): Promise<boolean> {
  return cache.ensureLoaded(weddingId, fetcher);
}

/**
 * Forget a wedding: release its rows and its reader's seat, drop its in-flight
 * slot and stop counting its writes as out, and bump its generation so a load
 * still in flight discards what it fetches. A view still holding the old
 * accessor reads `null` from then on.
 */
export function dropTasks(weddingId: string): void {
  cache.drop(weddingId);
  taskWrites.forget(weddingId);
  seats.get(weddingId)?.setSeat(null);
  seats.delete(weddingId);
}

/** Test-only: clear the whole cache, and the write counts, so each test starts
 *  cold. */
export function __resetTasksCache(): void {
  cache.reset();
  taskWrites.reset();
  seats.clear();
}
