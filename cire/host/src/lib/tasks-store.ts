// A `weddingId`-keyed cache for the organiser's checklist tasks — the sibling of
// `guests-store.ts`/`events-store.ts`. Same fetch-lift so switching modules
// doesn't refetch, and so the Overview "open tasks" widget and the Checklist
// view share ONE fetch. Effect is deliberately NOT imported (frontend code).
import { type Accessor, createSignal, type Setter } from "solid-js";

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

interface CacheEntry {
  tasks: Accessor<TaskRow[] | null>;
  setTasks: Setter<TaskRow[] | null>;
  viewerHostId: Accessor<string | null>;
  setViewerHostId: Setter<string | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [tasks, setTasks] = createSignal<TaskRow[] | null>(null);
    const [viewerHostId, setViewerHostId] = createSignal<string | null>(null);
    entry = { tasks, setTasks, viewerHostId, setViewerHostId };
    cache.set(weddingId, entry);
  }
  return entry;
}

export function tasksAccessor(weddingId: string): Accessor<TaskRow[] | null> {
  return entryFor(weddingId).tasks;
}

/**
 * Take a `GET …/tasks` answer apart: keep the caller's own seat id, which the
 * checklist puts first among a task's holders, and hand back the rows, read
 * through {@link readTaskRow}, for the loader to return. Every reader of the
 * list goes through here, so the seat is known whichever module read the tasks
 * first.
 */
export function readTaskList(weddingId: string, list: TaskList): TaskRow[] {
  if (!isWeddingClosed(weddingId)) entryFor(weddingId).setViewerHostId(list.viewerHostId ?? null);
  return list.tasks.map(readTaskRow);
}

/** The caller's own seat on the wedding, as the last task read named it;
 *  `null` before one. Reactive, and subscribes from a cold cache too. */
export function viewerHostIdOf(weddingId: string): string | null {
  return entryFor(weddingId).viewerHostId();
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function hasCachedTasks(weddingId: string): boolean {
  return !stale.has(weddingId) && cache.get(weddingId)?.tasks() != null;
}

export function setCachedTasks(weddingId: string, tasks: TaskRow[]): void {
  if (isWeddingClosed(weddingId)) return;
  entryFor(weddingId).setTasks(tasks);
}

/**
 * Replace the list with the whole list a write just answered with. It is the
 * newest read there is, so the wedding is fresh again, and the generation moves
 * on so a load already in flight — started before the write — discards what it
 * fetches instead of landing on top.
 */
export function setFreshTasks(weddingId: string, tasks: TaskRow[]): void {
  if (isWeddingClosed(weddingId)) return;
  generation.set(weddingId, generationOf(weddingId) + 1);
  entryFor(weddingId).setTasks(tasks);
  stale.delete(weddingId);
}

/** Subscribes only when the entry already exists — a read from a cold cache
 *  registers no dependency. Never use it for a value a view must track; use
 *  the accessor for that. */
export function peekCachedTasks(weddingId: string): TaskRow[] | null {
  return cache.get(weddingId)?.tasks() ?? null;
}

/**
 * Mark the wedding's rows out of date without touching a read in flight: the
 * tab was told its tasks changed, but no view of them is open. The next view
 * to open reads again. A read already out still lands, and shows its rows, but
 * leaves the wedding stale, since it may predate what changed.
 */
export function markTasksStale(weddingId: string): void {
  stale.add(weddingId);
  staleMarks.set(weddingId, staleMarksOf(weddingId) + 1);
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
  if (isWeddingClosed(weddingId)) return Promise.resolve(false);
  markTasksStale(weddingId);
  const settled = queueReread(weddingId, fetcher);
  sendReread(weddingId);
  return settled;
}

/** A read the store owes a wedding, and the promise every view that asked
 *  waits on. */
interface Reread {
  fetcher: () => Promise<TaskRow[]>;
  readonly settled: Promise<boolean>;
  readonly start: (load: Promise<boolean>) => void;
}

const rereads = new Map<string, Reread>();

function queueReread(weddingId: string, fetcher: () => Promise<TaskRow[]>): Promise<boolean> {
  const queued = rereads.get(weddingId);
  if (queued) {
    queued.fetcher = fetcher;
    return queued.settled;
  }
  let start!: (load: Promise<boolean>) => void;
  const settled = new Promise<boolean>((resolve) => {
    start = resolve;
  });
  // A read queued again after a drop has no caller of its own; a failure is
  // still handed to every view that asked for it.
  settled.catch(() => undefined);
  rereads.set(weddingId, { fetcher, settled, start });
  return settled;
}

/** Send the read a wedding is owed, unless a read is in flight or one of the
 *  portal's own writes is out: each calls this again when it ends. */
function sendReread(weddingId: string): void {
  const queued = rereads.get(weddingId);
  if (!queued || writing.has(weddingId) || inflight.has(weddingId)) return;
  rereads.delete(weddingId);
  stale.add(weddingId);
  queued.start(ensureTasksLoaded(weddingId, queued.fetcher));
}

/** Settle a wedding's owed read as not loaded, and send nothing. */
function forgetReread(weddingId: string): void {
  rereads.get(weddingId)?.start(Promise.resolve(false));
  rereads.delete(weddingId);
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
  // discards its result instead of caching it. Dropping the in-flight slot
  // here (not just bumping the generation) means the next
  // `ensureTasksLoaded` does not join that doomed fetch — it starts a new
  // one, at the cost of one extra request. That is the right trade: joining
  // would await a promise whose result the generation guard is about to
  // discard, leaving the caller with `false` and the view unrefreshed until
  // whatever call comes next.
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Monotonic per-wedding load generation, bumped by every invalidation, by a
 *  write's whole-list answer and by forgetting the wedding: a load from an
 *  older generation has been replaced, and drops what it fetches. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;

/** Per-wedding count of the starts and ends of the portal's own task writes:
 *  a load that sees it move was answered across one of them. */
const writeEpoch = new Map<string, number>();
const writeEpochOf = (weddingId: string) => writeEpoch.get(weddingId) ?? 0;

/** Per-wedding count of {@link markTasksStale} calls: a load that sees it move
 *  may predate the change it was told of. */
const staleMarks = new Map<string, number>();
const staleMarksOf = (weddingId: string) => staleMarks.get(weddingId) ?? 0;

/** How many of the portal's own task writes are out, per wedding. */
const writing = new Map<string, number>();

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
 * reached the tab first, the write's answer or its signal.
 */
export function beginTaskWrite(weddingId: string): () => void {
  writing.set(weddingId, (writing.get(weddingId) ?? 0) + 1);
  writeEpoch.set(weddingId, writeEpochOf(weddingId) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (writing.get(weddingId) ?? 1) - 1;
    if (left > 0) writing.set(weddingId, left);
    else writing.delete(weddingId);
    writeEpoch.set(weddingId, writeEpochOf(weddingId) + 1);
    sendReread(weddingId);
  };
}

/** Wedding ids whose cached rows are known out of date but still worth showing
 *  while the refetch is in flight. */
const stale = new Set<string>();

/** Reactive open-task count for the Overview widget: `null` until first load.
 *  Mints the wedding's cache entry so the read subscribes even from a cold
 *  cache — the entry is per-wedding and bounded by the same key space
 *  `cache`, `generation` and `stale` already occupy. */
export function openTaskCount(weddingId: string): number | null {
  const rows = entryFor(weddingId).tasks();
  if (rows == null) return null;
  return rows.filter((t) => t.status === "open").length;
}

/** Reactive open/done/total counts for the Overview completion bar: `null`
 *  until first load. Mints the wedding's cache entry so the read subscribes
 *  even from a cold cache (mirrors {@link openTaskCount}) — the entry is
 *  per-wedding and bounded by the same key space `cache`, `generation` and
 *  `stale` already occupy. */
export function taskCounts(
  weddingId: string,
): { open: number; done: number; total: number } | null {
  const rows = entryFor(weddingId).tasks();
  if (rows == null) return null;
  let open = 0;
  let done = 0;
  for (const t of rows) {
    if (t.status === "open") open += 1;
    else if (t.status === "done") done += 1;
  }
  return { open, done, total: rows.length };
}

const inflight = new Map<string, Promise<boolean>>();

export function ensureTasksLoaded(
  weddingId: string,
  fetcher: () => Promise<TaskRow[]>,
): Promise<boolean> {
  // A closed wedding loads nothing: the caller is a view that has already
  // been torn down.
  if (isWeddingClosed(weddingId)) return Promise.resolve(false);
  if (hasCachedTasks(weddingId)) return Promise.resolve(true);
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const startedEpoch = writeEpochOf(weddingId);
    const startedMarks = staleMarksOf(weddingId);
    const load = fetcher()
      .then(
        (rows) => {
          // A newer invalidation or a write's whole-list answer landed while
          // this was in flight: a newer load owns the entry, so drop the rows.
          if (generationOf(weddingId) !== startedAt) return false;
          // One of the portal's own writes started or ended while this was in
          // flight, or one is out now: the rows may predate it. Drop them and
          // read again once the last write has ended.
          if (writeEpochOf(weddingId) !== startedEpoch || writing.has(weddingId)) {
            stale.add(weddingId);
            void queueReread(weddingId, fetcher);
            return false;
          }
          setCachedTasks(weddingId, rows);
          if (staleMarksOf(weddingId) === startedMarks) stale.delete(weddingId);
          return true;
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
        sendReread(weddingId);
      });
    pending = load;
    inflight.set(weddingId, pending);
  }
  return pending;
}

/**
 * Forget a wedding: release its rows, drop its in-flight slot, and bump its
 * generation so a load still in flight discards what it fetches. A view still
 * holding the old accessor reads `null` from then on. The generation is bumped
 * rather than deleted, because a deleted one reads as 0 — the same value an
 * old load captured — and that load would then cache what it fetched.
 */
export function dropTasks(weddingId: string): void {
  cache.get(weddingId)?.setTasks(null);
  cache.delete(weddingId);
  inflight.delete(weddingId);
  stale.delete(weddingId);
  writing.delete(weddingId);
  forgetReread(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetTasksCache(): void {
  for (const weddingId of rereads.keys()) forgetReread(weddingId);
  cache.clear();
  inflight.clear();
  generation.clear();
  writeEpoch.clear();
  staleMarks.clear();
  stale.clear();
  writing.clear();
}
