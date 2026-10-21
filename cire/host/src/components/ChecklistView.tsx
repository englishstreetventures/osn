import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import {
  closestCenter,
  createSortable,
  createSortableList,
  DragDropProvider,
  DragDropSensors,
  maybeTransformStyle,
  SortableProvider,
  useDragDropContext,
} from "@shared/sortable";
import { toast } from "@shared/toast";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Select } from "@shared/ui/ui/select";
import { createEffect, createMemo, createSignal, For, on, onMount, Show, untrack } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { TIMEFRAME_BUCKETS, type TimeframeBucket } from "../lib/checklist-buckets";
import { haptic } from "../lib/haptics";
import { createHolderWrites, readerFirst } from "../lib/holder-writes";
import {
  ensureHostsLoaded,
  type HostSeat,
  hostsAccessor,
  invalidateHosts,
} from "../lib/hosts-store";
import { useMembersChanged } from "../lib/members-changed";
import { sameButOrder } from "../lib/sortable-rows";
import { useTasksChanged } from "../lib/tasks-changed";
import {
  beginTaskWrite,
  ensureTasksLoaded,
  invalidateTasks,
  peekCachedTasks,
  readTaskList,
  readTaskRow,
  setCachedTasks,
  type TaskList,
  type TaskRow,
  type TaskWire,
  tasksAccessor,
  viewerHostIdOf,
} from "../lib/tasks-store";
import { normaliseWeddingRole } from "../lib/wedding-roles";
import ChecklistStarter from "./ChecklistStarter";
import ReorderControls from "./ReorderControls";
import TaskHolders, { type Holder } from "./TaskHolders";
/** A bucket with nothing in it. One shared array, so `sameRows` sees an empty
 *  bucket as unchanged from one write to the next. */
const NO_TASKS: TaskRow[] = [];

/** Same rows, same order, same objects: a write elsewhere in the checklist left
 *  this bucket alone, so nothing that reads it needs to run again. */
const sameRows = <T,>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((row, k) => row === b[k]);

interface ChecklistViewProps {
  weddingId: string;
  /** Owner/editor may add, edit, complete, reorder; a viewer sees a read-only list. */
  canEdit?: boolean;
  /** Owner? Decides how the starter checklist asks for a missing wedding date. */
  canManage?: boolean;
}

export default function ChecklistView(props: ChecklistViewProps) {
  const { authFetch } = useAuth();
  const tasks = tasksAccessor(props.weddingId);
  const [error, setError] = createSignal<string | null>(null);
  const [newTitle, setNewTitle] = createSignal("");
  const [newBucket, setNewBucket] = createSignal<TimeframeBucket>(TIMEFRAME_BUCKETS[0]!.key);
  const [newDue, setNewDue] = createSignal("");

  const listUrl = () => apiUrl(weddingPath(props.weddingId, "/tasks"));

  const load = async (): Promise<TaskRow[]> => {
    const res = await authFetch(listUrl());
    if (res.status === 401) {
      redirectToLogin();
      return [];
    }
    if (!res.ok) throw new Error(`Failed to load checklist (${res.status})`);
    return readTaskList(props.weddingId, (await res.json()) as TaskList);
  };

  onMount(() => {
    ensureTasksLoaded(props.weddingId, load).catch((err) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load your checklist. Refresh to try again.");
    });
  });

  // ── Who holds each task ────────────────────────────────────────────────
  // The seats are read only once some task is held: a checklist nobody is on
  // needs no names, and an owner or editor who opens a task's popover asks
  // for them then.
  const seats = hostsAccessor(props.weddingId);
  const seatById = createMemo(() => new Map(seats()?.map((s) => [s.hostId, s])));
  const [seatsFailed, setSeatsFailed] = createSignal(false);
  /** Has this visit asked the server for the seats? Until it has, the first
   *  popover opened asks: seats cached before the visit may miss someone
   *  seated or re-roled in another session since. */
  let seatsReadThisVisit = false;
  /** The reader's own seat, first among a task's holders. */
  const viewerHostId = () => viewerHostIdOf(props.weddingId);

  const loadSeats = async (): Promise<HostSeat[]> => {
    seatsReadThisVisit = true;
    const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/hosts")));
    if (res.status === 401) {
      redirectToLogin();
      return [];
    }
    if (!res.ok) throw new Error(`Failed to load the wedding's people (${res.status})`);
    const { hosts } = (await res.json()) as { hosts: HostSeat[] };
    // A role the portal does not know reads as the narrowest one.
    for (const seat of hosts) seat.role = normaliseWeddingRole(seat.role);
    return hosts;
  };

  /** Read the seats unless they are fresh. A failure from an earlier read is
   *  forgotten as this one starts, so a retry says it is looking, not that it
   *  failed. */
  const ensureSeats = () => {
    setSeatsFailed(false);
    return ensureHostsLoaded(props.weddingId, loadSeats).catch((err: unknown) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setSeatsFailed(true);
    });
  };

  const anyAssigned = createMemo(() => (tasks() ?? []).some((t) => t.assigneeHostIds.length > 0));
  createEffect(() => {
    if (anyAssigned()) void untrack(ensureSeats);
  });

  /** Open a task's popover with the seats it offers. The first opening of a
   *  visit reads them from the server unless the visit already has; later
   *  ones use that read. */
  const openPeople = () => {
    if (!seatsReadThisVisit) invalidateHosts(props.weddingId);
    void ensureSeats();
  };

  const holderWrites = createHolderWrites({
    send: async (taskId, hostId, on) => {
      const done = beginTaskWrite(props.weddingId);
      try {
        return await authFetch(
          apiUrl(
            weddingPath(
              props.weddingId,
              `/tasks/${encodeURIComponent(taskId)}/assignees/${encodeURIComponent(hostId)}`,
            ),
          ),
          { method: on ? "PUT" : "DELETE" },
        );
      } finally {
        done();
      }
    },
    holdersOf: (taskId) =>
      peekCachedTasks(props.weddingId)?.find((t) => t.id === taskId)?.assigneeHostIds,
    setHolders: (taskId, assigneeHostIds) =>
      patchTasks((rows) => rows.map((t) => (t.id === taskId ? { ...t, assigneeHostIds } : t))),
    isAuthExpired,
    onSignedOut: redirectToLogin,
    // Not one of the wedding's seats any more: removed since the popover read
    // them, so they are read again.
    onSeatGone: () => {
      invalidateHosts(props.weddingId);
      void ensureSeats();
    },
    onRefused: (why) => {
      haptic("reject");
      toast.error(
        why === "not_in_wedding"
          ? "That person is no longer on this wedding. Pick someone else."
          : "Couldn't change who holds that task.",
      );
      void reload();
    },
  });

  /**
   * A task's holders as its row shows them, from what it holds with the picks
   * still out laid over it: the reader first, then the order they were put on
   * it. Once the seats have loaded, a seat the list no longer has has gone —
   * the server took it off its tasks — and is left out until the tasks are
   * read again.
   */
  const holdersOf = (holding: readonly string[]): Holder[] => {
    const ids = readerFirst(holding, viewerHostId());
    if (seats() === null) return ids.map((hostId) => ({ hostId }));
    return ids.flatMap((hostId) => {
      const seat = seatById().get(hostId);
      return seat ? [{ hostId, seat }] : [];
    });
  };

  // Refetch from the server and repopulate the cache (used after a write
  // fails, and when the wedding's socket says the tasks changed).
  const reload = async () => {
    invalidateTasks(props.weddingId);
    try {
      await ensureTasksLoaded(props.weddingId, load);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't refresh your checklist.");
    }
  };

  // The open wedding's socket: someone changed the tasks, or the socket came
  // back and may have missed it. A re-read that lands while one of this view's
  // own writes is out is dropped (`beginTaskWrite`), and the write's own signal
  // asks again, so a re-read never undoes what the organiser just did.
  createEffect(on(useTasksChanged(), () => void reload(), { defer: true }));
  // Someone's seat changed. The holder stacks name seats, so a view that has
  // read them reads them again; one that never needed them asks for nothing.
  createEffect(
    on(
      useMembersChanged(),
      () => {
        if (!untrack(anyAssigned) && !seatsReadThisVisit) return;
        invalidateHosts(props.weddingId);
        void ensureSeats();
      },
      { defer: true },
    ),
  );

  // Each bucket's tasks in order. A map of fresh arrays holding the SAME task
  // objects, so a bucket untouched by a write compares equal (`sameRows`).
  const tasksByBucket = createMemo(() => {
    const byBucket = new Map<TimeframeBucket, TaskRow[]>();
    for (const task of tasks() ?? []) {
      const bucket = byBucket.get(task.timeframeBucket as TimeframeBucket);
      if (bucket) bucket.push(task);
      else byBucket.set(task.timeframeBucket as TimeframeBucket, [task]);
    }
    for (const bucket of byBucket.values()) bucket.sort((a, c) => a.sortOrder - c.sortOrder);
    return byBucket;
  });

  // Writes only onto a loaded list. A list that isn't loaded has nothing to
  // patch, and one built from nothing would read as a complete checklist and
  // stop the next load from asking the server.
  const patchTasks = (fn: (rows: TaskRow[]) => TaskRow[]): boolean => {
    const cur = peekCachedTasks(props.weddingId);
    if (!cur) return false;
    setCachedTasks(props.weddingId, fn(cur));
    return true;
  };

  const addTask = async (e: Event) => {
    e.preventDefault();
    const title = newTitle().trim();
    if (!title) return;
    setError(null);
    const body = {
      title,
      timeframeBucket: newBucket(),
      dueAt: newDue() || null,
    };
    setNewTitle("");
    setNewDue("");
    const done = beginTaskWrite(props.weddingId);
    try {
      const res = await authFetch(listUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`create ${res.status}`);
      const task = readTaskRow(((await res.json()) as { task: TaskWire }).task);
      const added = patchTasks((rows) => [...rows, task]);
      done();
      // No list to add it to: load one, which will carry the new task.
      if (!added) void reload();
      haptic("commit");
    } catch {
      done();
      haptic("reject");
      setError("Couldn't add that task.");
      void reload();
    } finally {
      done();
    }
  };

  const toggleDone = async (task: TaskRow) => {
    const nextStatus = task.status === "done" ? "open" : "done";
    // Optimistic flip. The haptic rides with it rather than with the response:
    // the tick is what the host is confirming, and a buzz arriving a network
    // round-trip after the box changed would read as a second, separate event.
    const done = beginTaskWrite(props.weddingId);
    patchTasks((rows) => rows.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(weddingPath(props.weddingId, `/tasks/${encodeURIComponent(task.id)}`)),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch ${res.status}`);
      const updated = readTaskRow(((await res.json()) as { task: TaskWire }).task);
      patchTasks((rows) => rows.map((t) => (t.id === updated.id ? updated : t)));
    } catch {
      // The optimistic tick is about to be taken back — say so.
      done();
      haptic("reject");
      setError("Couldn't update that task.");
      void reload();
    } finally {
      done();
    }
  };

  const deleteTask = async (task: TaskRow) => {
    const done = beginTaskWrite(props.weddingId);
    patchTasks((rows) => rows.filter((t) => t.id !== task.id));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(weddingPath(props.weddingId, `/tasks/${encodeURIComponent(task.id)}`)),
        {
          method: "DELETE",
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      done();
      haptic("reject");
      setError("Couldn't delete that task.");
      void reload();
    } finally {
      done();
    }
  };

  /**
   * Move a task within its bucket, then save the bucket's new order. A drag can
   * move it several places at once. Only tasks whose stored `sortOrder` changes
   * get a new object, and the rows are keyed by id and ignore an order-only
   * change, so no row is rebuilt. `onFailure` withdraws the move's
   * announcement, since the reload that follows puts the old order back.
   */
  const move = async (bucket: TimeframeBucket, from: number, to: number, onFailure: () => void) => {
    const items = tasksByBucket().get(bucket) ?? [];
    if (from === to || to < 0 || to >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);
    const orderedIds = reordered.map((t) => t.id);
    const bySort = new Map(orderedIds.map((id, i) => [id, i]));
    const done = beginTaskWrite(props.weddingId);
    const moves = patchTasks((rows) =>
      rows.map((t) => {
        const next = t.timeframeBucket === bucket ? bySort.get(t.id) : undefined;
        return next === undefined || next === t.sortOrder ? t : { ...t, sortOrder: next };
      }),
    );
    if (!moves) return done();
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/tasks/reorder")), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeframeBucket: bucket, orderedIds }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`reorder ${res.status}`);
    } catch {
      done();
      haptic("reject");
      setError("Couldn't save the new order.");
      onFailure();
      void reload();
    } finally {
      done();
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <Show when={error()}>
        <Notice tone="danger" alert>
          {error()}
        </Notice>
      </Show>

      <Show when={props.canEdit}>
        <ChecklistStarter
          weddingId={props.weddingId}
          canManage={props.canManage}
          taskCount={tasks()?.length ?? null}
        />
      </Show>

      <Show when={props.canEdit}>
        <form
          onSubmit={addTask}
          class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4"
        >
          <Field label="Task" class="min-w-48 flex-1">
            {(field) => (
              <Input
                {...field}
                value={newTitle()}
                onInput={(e) => setNewTitle(e.currentTarget.value)}
                placeholder="Book the venue"
              />
            )}
          </Field>
          <Field label="When">
            {(field) => (
              <Select
                {...field}
                value={newBucket()}
                onChange={(e) => setNewBucket(e.currentTarget.value as TimeframeBucket)}
              >
                <For each={TIMEFRAME_BUCKETS}>
                  {(b) => <option value={b.key}>{b.label}</option>}
                </For>
              </Select>
            )}
          </Field>
          <Field label="Due (optional)">
            {(field) => (
              <Input
                {...field}
                type="date"
                value={newDue()}
                onInput={(e) => setNewDue(e.currentTarget.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary">
            Add task
          </Button>
        </form>
      </Show>

      {/* Lead-time buckets side by side once there's room: each bucket is a
          short list, so a single column left most of a widescreen empty while
          pushing "6+ months out" below the fold. Column count is intrinsic —
          `auto-grid` fits as many ≥22rem buckets as the panel allows, and a
          task reorders within its own bucket either way.
          `items-start` so a long bucket doesn't stretch its neighbours. */}
      <div class="auto-grid items-start [--auto-grid-gap:1.5rem] [--auto-grid-min:22rem]">
        {/* Over the fixed bucket list, not over a memo of groups: each bucket's
            sortable list holds its grips (focus goes back to one after a move)
            and its live region, so it has to outlive every write to the tasks. */}
        <For each={TIMEFRAME_BUCKETS}>
          {(bucket) => {
            const bucketTasks = createMemo(
              () => tasksByBucket().get(bucket.key) ?? NO_TASKS,
              NO_TASKS,
              {
                equals: sameRows,
              },
            );
            const count = createMemo(() => bucketTasks().length);
            const ids = createMemo(() => bucketTasks().map((t) => t.id));
            const taskById = createMemo(() => new Map(bucketTasks().map((t) => [t.id, t])));
            // One list per bucket: a task only ever moves within its own bucket,
            // because moving it to another is a change of when, not of order.
            const reorder = createSortableList({
              ids,
              labelFor: (id) => untrack(() => taskById().get(String(id))?.title) ?? "task",
              noun: "task",
              onMove: (from, to) => void move(bucket.key, from, to, reorder.clearAnnouncement),
              onPhase: (phase) => haptic(phase),
            });
            return (
              <section class="flex flex-col gap-2">
                <h3 class="text-gold-dim font-body text-ui-xs tracking-ui-widest uppercase">
                  {bucket.label}
                </h3>
                <Show
                  when={bucketTasks().length > 0}
                  fallback={<p class="text-text-muted text-ui-sm italic">Nothing here yet.</p>}
                >
                  <DragDropProvider {...reorder.dragHandlers} collisionDetector={closestCenter}>
                    <DragDropSensors />
                    <ul class="flex flex-col gap-1" data-testid={`tasks-${bucket.key}`}>
                      <SortableProvider ids={ids()}>
                        <For each={ids()}>
                          {(id, i) => {
                            // By id, so a move moves this row's node rather than rebuilding
                            // it; `sameButOrder` keeps the old object when only the stored
                            // order or the holders changed, and the keyed `Show` rebuilds
                            // the row when anything else did, as an edit always has. The
                            // holders are read live below, so a change of who holds the
                            // task keeps the row — and its popover open.
                            const row = createMemo(() => taskById().get(id), undefined, {
                              equals: (a, b) => sameButOrder(a, b, ["assigneeHostIds"]),
                            });
                            const live = () => taskById().get(id);
                            return (
                              <Show when={row()} keyed>
                                {(task) => {
                                  const sortable = createSortable(task.id);
                                  // Non-null: rendered inside the DragDropProvider above.
                                  const [dndState] = useDragDropContext()!;
                                  const item = reorder.item(task.id, i, count);
                                  // Every pick anywhere re-reads this; the
                                  // same seats in the same order stop there.
                                  const holding = createMemo(
                                    () =>
                                      holderWrites.shown(task.id, (live() ?? task).assigneeHostIds),
                                    [],
                                    { equals: sameRows },
                                  );
                                  const holders = createMemo(() => holdersOf(holding()));
                                  return (
                                    <li
                                      ref={sortable.ref}
                                      style={maybeTransformStyle(sortable.transform())}
                                      class="border-border bg-surface/10 relative flex items-center gap-3 rounded-sm border px-3 py-2"
                                      classList={{
                                        "border-gold/60 bg-surface/80 z-10 shadow-lg":
                                          sortable.isActiveDraggable(),
                                        "transition-transform":
                                          dndState.dragging() && !sortable.isActiveDraggable(),
                                      }}
                                    >
                                      <Show when={props.canEdit}>
                                        <ReorderControls sortable={sortable} item={item} />
                                      </Show>
                                      <input
                                        type="checkbox"
                                        aria-label={task.title}
                                        checked={task.status === "done"}
                                        disabled={!props.canEdit}
                                        onChange={() => props.canEdit && toggleDone(task)}
                                      />
                                      <span
                                        class={`text-ui-base flex-1 ${
                                          task.status === "done"
                                            ? "text-text-muted line-through"
                                            : "text-text"
                                        }`}
                                      >
                                        {task.title}
                                        <Show when={task.dueAt}>
                                          <span class="text-text-muted text-ui-xs ml-2">
                                            · due {task.dueAt}
                                          </span>
                                        </Show>
                                      </span>
                                      <TaskHolders
                                        title={task.title}
                                        open={task.status === "open"}
                                        holders={holders()}
                                        canAssign={props.canEdit === true}
                                        seats={seats()}
                                        seatsFailed={seatsFailed()}
                                        viewerHostId={viewerHostId()}
                                        holds={(hostId) => holding().includes(hostId)}
                                        busy={holderWrites.busy(task.id)}
                                        onOpen={openPeople}
                                        onToggle={(hostId) => {
                                          haptic("commit");
                                          holderWrites.toggle(task.id, hostId);
                                        }}
                                      />
                                      <Show when={props.canEdit}>
                                        <Button
                                          variant="bareDanger"
                                          type="button"
                                          aria-label="Delete task"
                                          onClick={() => deleteTask(task)}
                                        >
                                          ✕
                                        </Button>
                                      </Show>
                                    </li>
                                  );
                                }}
                              </Show>
                            );
                          }}
                        </For>
                      </SortableProvider>
                    </ul>
                  </DragDropProvider>
                </Show>
                <Show when={props.canEdit}>
                  <p {...reorder.hintProps()}>{reorder.hintText}</p>
                  <p {...reorder.liveRegionProps()}>{reorder.announcement()}</p>
                </Show>
              </section>
            );
          }}
        </For>
      </div>
    </div>
  );
}
