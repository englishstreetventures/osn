import { useAuth } from "@osn/client/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { TIMEFRAME_BUCKETS, type TimeframeBucket } from "../lib/checklist-buckets";
import {
  ensureTasksLoaded,
  invalidateTasks,
  peekCachedTasks,
  setCachedTasks,
  type TaskRow,
  tasksAccessor,
} from "../lib/tasks-store";

interface ChecklistViewProps {
  weddingId: string;
  /** Owner/editor may add, edit, complete, reorder; a viewer sees a read-only list. */
  canEdit?: boolean;
}

export default function ChecklistView(props: ChecklistViewProps) {
  const { authFetch } = useAuth();
  const tasks = tasksAccessor(props.weddingId);
  const [error, setError] = createSignal<string | null>(null);
  const [newTitle, setNewTitle] = createSignal("");
  const [newBucket, setNewBucket] = createSignal<TimeframeBucket>(TIMEFRAME_BUCKETS[0]!.key);
  const [newDue, setNewDue] = createSignal("");

  const listUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks`);

  const load = async (): Promise<TaskRow[]> => {
    const res = await authFetch(listUrl());
    if (res.status === 401) {
      redirectToLogin();
      return [];
    }
    if (!res.ok) throw new Error(`Failed to load checklist (${res.status})`);
    return ((await res.json()) as { tasks: TaskRow[] }).tasks;
  };

  onMount(() => {
    ensureTasksLoaded(props.weddingId, load).catch((err) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load your checklist. Refresh to try again.");
    });
  });

  // Refetch from the server and repopulate the cache (used after a write fails).
  const reload = async () => {
    invalidateTasks(props.weddingId);
    try {
      setCachedTasks(props.weddingId, await load());
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't refresh your checklist.");
    }
  };

  // Tasks grouped by bucket, each list already sort_order-ascending from the API.
  const grouped = createMemo(() => {
    const rows = tasks() ?? [];
    return TIMEFRAME_BUCKETS.map((b) => ({
      bucket: b,
      items: rows
        .filter((t) => t.timeframeBucket === b.key)
        .sort((a, c) => a.sortOrder - c.sortOrder),
    }));
  });

  const patchCache = (next: TaskRow[]) => setCachedTasks(props.weddingId, next);

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
    try {
      const res = await authFetch(listUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`create ${res.status}`);
      const { task } = (await res.json()) as { task: TaskRow };
      patchCache([...(peekCachedTasks(props.weddingId) ?? []), task]);
    } catch {
      setError("Couldn't add that task.");
      void reload();
    }
  };

  const toggleDone = async (task: TaskRow) => {
    const nextStatus = task.status === "done" ? "open" : "done";
    // Optimistic flip.
    patchCache(
      (peekCachedTasks(props.weddingId) ?? []).map((t) =>
        t.id === task.id ? { ...t, status: nextStatus } : t,
      ),
    );
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks/${task.id}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch ${res.status}`);
      const { task: updated } = (await res.json()) as { task: TaskRow };
      patchCache(
        (peekCachedTasks(props.weddingId) ?? []).map((t) => (t.id === updated.id ? updated : t)),
      );
    } catch {
      setError("Couldn't update that task.");
      void reload();
    }
  };

  const deleteTask = async (task: TaskRow) => {
    patchCache((peekCachedTasks(props.weddingId) ?? []).filter((t) => t.id !== task.id));
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks/${task.id}`),
        { method: "DELETE" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      setError("Couldn't delete that task.");
      void reload();
    }
  };

  // Move a task up/down within its bucket, then persist the new order.
  const move = async (bucket: TimeframeBucket, index: number, delta: -1 | 1) => {
    const items = (peekCachedTasks(props.weddingId) ?? [])
      .filter((t) => t.timeframeBucket === bucket)
      .sort((a, c) => a.sortOrder - c.sortOrder);
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    // Rewrite sort_order locally + in the cache.
    const orderedIds = reordered.map((t) => t.id);
    const bySort = new Map(orderedIds.map((id, i) => [id, i]));
    patchCache(
      (peekCachedTasks(props.weddingId) ?? []).map((t) =>
        t.timeframeBucket === bucket ? { ...t, sortOrder: bySort.get(t.id) ?? t.sortOrder } : t,
      ),
    );
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks/reorder`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timeframeBucket: bucket, orderedIds }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`reorder ${res.status}`);
    } catch {
      setError("Couldn't save the new order.");
      void reload();
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <Show when={error()}>
        <p class="border-error/40 text-error rounded-sm border px-3 py-2 text-[0.82rem]">
          {error()}
        </p>
      </Show>

      <Show when={props.canEdit}>
        <form
          onSubmit={addTask}
          class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4"
        >
          <label class="flex min-w-[12rem] flex-1 flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              Task
            </span>
            <input
              type="text"
              value={newTitle()}
              onInput={(e) => setNewTitle(e.currentTarget.value)}
              placeholder="Book the venue"
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              When
            </span>
            <select
              value={newBucket()}
              onChange={(e) => setNewBucket(e.currentTarget.value as TimeframeBucket)}
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            >
              <For each={TIMEFRAME_BUCKETS}>{(b) => <option value={b.key}>{b.label}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              Due (optional)
            </span>
            <input
              type="date"
              value={newDue()}
              onInput={(e) => setNewDue(e.currentTarget.value)}
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            />
          </label>
          <button
            type="submit"
            class="bg-gold text-bg rounded-sm px-4 py-2 text-[0.82rem] tracking-[0.08em] uppercase"
          >
            Add task
          </button>
        </form>
      </Show>

      <For each={grouped()}>
        {(group) => (
          <section class="flex flex-col gap-2">
            <h3 class="text-gold-dim font-body text-[0.7rem] tracking-[0.18em] uppercase">
              {group.bucket.label}
            </h3>
            <Show
              when={group.items.length > 0}
              fallback={<p class="text-text-muted text-[0.8rem] italic">Nothing here yet.</p>}
            >
              <ul class="flex flex-col gap-1">
                <For each={group.items}>
                  {(task, i) => (
                    <li class="border-border bg-surface/10 flex items-center gap-3 rounded-sm border px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={task.title}
                        checked={task.status === "done"}
                        disabled={!props.canEdit}
                        onChange={() => props.canEdit && toggleDone(task)}
                      />
                      <span
                        class={`flex-1 text-[0.9rem] ${
                          task.status === "done" ? "text-text-muted line-through" : "text-text"
                        }`}
                      >
                        {task.title}
                        <Show when={task.dueAt}>
                          <span class="text-text-muted ml-2 text-[0.72rem]">
                            · due {task.dueAt}
                          </span>
                        </Show>
                      </span>
                      <Show when={props.canEdit}>
                        <div class="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Move up"
                            disabled={i() === 0}
                            onClick={() => move(group.bucket.key, i(), -1)}
                            class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label="Move down"
                            disabled={i() === group.items.length - 1}
                            onClick={() => move(group.bucket.key, i(), 1)}
                            class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            aria-label="Delete task"
                            onClick={() => deleteTask(task)}
                            class="text-text-muted hover:text-error px-1"
                          >
                            ✕
                          </button>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
}
