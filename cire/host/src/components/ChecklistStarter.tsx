import Button from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import Eyebrow from "@cire/ui/eyebrow";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { createMemo, createSignal, For, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { TIMEFRAME_BUCKETS } from "../lib/checklist-buckets";
import { haptic } from "../lib/haptics";
import { toLocalDateKey } from "../lib/overview-agenda";
import { readTaskRow, setFreshTasks, type TaskWire } from "../lib/tasks-store";

const STARTER_CLASS = `${cardClass({ padding: "sm" })} items-start`;

/** One template item as `GET …/tasks/templates/:id` previews it. */
interface PreviewItem {
  key: string;
  title: string;
  timeframeBucket: string;
  /** `YYYY-MM-DD`, or null when the wedding has no date. */
  dueAt: string | null;
  /** `added`: on the checklist already. `removed`: the couple deleted it. */
  state: "new" | "added" | "removed";
}

interface Preview {
  weddingDate: string | null;
  items: PreviewItem[];
}

interface ChecklistStarterProps {
  weddingId: string;
  /** Owner? Only an owner can set the wedding date the due dates count from. */
  canManage?: boolean;
  /** Tasks on the checklist, or null before they load. An empty checklist gets
   *  the full offer; a full one a quiet button. */
  taskCount: number | null;
}

const TEMPLATE = "starter";
const TITLE_ID = "checklist-starter-title";

/**
 * The starter checklist: a preview of suggested tasks, each due a set time
 * before the wedding date, from which the couple picks what to add. Rendered
 * for an owner or editor only.
 *
 * Ticked at first: every item not yet on the checklist whose date is still
 * ahead (or that has no date yet). Left for the couple to tick: an item whose
 * date has already passed, which would land as overdue, and an item they
 * deleted earlier — ticking that one is how they ask for it back.
 */
export default function ChecklistStarter(props: ChecklistStarterProps) {
  const { authFetch } = useAuth();
  const [open, setOpen] = createSignal(false);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [applyError, setApplyError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());

  const path = () => apiUrl(weddingPath(props.weddingId, `/tasks/templates/${TEMPLATE}`));

  // The organiser's own calendar day, as the Overview agenda counts overdue.
  const isPast = (item: PreviewItem) =>
    item.dueAt !== null && item.dueAt < toLocalDateKey(Date.now())!;

  async function show() {
    setOpen(true);
    setPreview(null);
    setPicked(new Set<string>());
    setLoadError(null);
    setApplyError(null);
    try {
      const res = await authFetch(path());
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`preview ${res.status}`);
      const { preview: loaded } = (await res.json()) as { preview: Preview };
      setPicked(
        new Set(
          loaded.items.filter((item) => item.state === "new" && !isPast(item)).map((i) => i.key),
        ),
      );
      setPreview(loaded);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setLoadError("Couldn't load the starter checklist. Try again in a moment.");
    }
  }

  // Every close — Cancel, Escape, the backdrop, even while an apply is in
  // flight — goes through here, so the signal never says open about a dialog
  // the browser has closed (which would stop the next `show()` reopening it).
  function close() {
    setOpen(false);
  }

  function toggle(key: string) {
    const next = new Set(picked());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  }

  const items = () => preview()?.items ?? [];
  // The items still to add, under their buckets in the checklist's order.
  const groups = createMemo(() =>
    TIMEFRAME_BUCKETS.map((bucket) => ({
      label: bucket.label,
      items: items().filter((i) => i.state === "new" && i.timeframeBucket === bucket.key),
    })).filter((group) => group.items.length > 0),
  );
  const removed = createMemo(() => items().filter((i) => i.state === "removed"));
  const addedCount = createMemo(() => items().filter((i) => i.state === "added").length);
  const count = () => picked().size;

  async function apply() {
    if (busy() || count() === 0) return;
    setBusy(true);
    setApplyError(null);
    try {
      const res = await authFetch(path(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [...picked()] }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`apply ${res.status}`);
      const { added, tasks } = (await res.json()) as { added: number; tasks: TaskWire[] };
      // The answer is the whole checklist after the apply, so it is the list.
      setFreshTasks(props.weddingId, tasks.map(readTaskRow));
      haptic("commit");
      toast.success(
        added === 0
          ? "Those tasks are already on your checklist."
          : `Added ${added} ${added === 1 ? "task" : "tasks"} to your checklist.`,
      );
      setOpen(false);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      const message = "Couldn't add those tasks. Try again in a moment.";
      // Closed while the apply was in flight: the dialog is not there to say so.
      if (open()) setApplyError(message);
      else toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const row = (item: PreviewItem) => (
    <li>
      <label class="text-ui-base text-text flex cursor-pointer items-start gap-3 py-1">
        <input
          type="checkbox"
          class="mt-1"
          checked={picked().has(item.key)}
          onChange={() => toggle(item.key)}
        />
        <span class="flex flex-1 flex-col">
          <span>{item.title}</span>
          <Show when={item.dueAt}>
            {(due) => (
              <span class="text-text-muted text-ui-xs" data-numeric>
                due {due()}
                {isPast(item) ? " · date passed" : ""}
              </span>
            )}
          </Show>
        </span>
      </label>
    </li>
  );

  return (
    <>
      <Show when={props.taskCount !== null}>
        <Show
          when={props.taskCount === 0}
          fallback={
            <Button variant="quiet" size="sm" class="self-end" onClick={() => void show()}>
              Starter checklist
            </Button>
          }
        >
          <section class={STARTER_CLASS}>
            <h3 class="font-display text-text text-ui-md font-light">
              Start from a suggested checklist
            </h3>
            <p class="text-text-muted text-ui-sm leading-ui-snug max-w-prose">
              About twenty common planning tasks, each due a set time before your wedding. Pick the
              ones that fit; they become ordinary tasks you can change or delete.
            </p>
            <Button variant="primary" onClick={() => void show()}>
              Preview the starter checklist
            </Button>
          </section>
        </Show>
      </Show>

      {/* `frame`: the list scrolls under a title and an action bar that stay
          put, so "Add" is always in reach however long the list runs. */}
      <Modal open={open()} onClose={close} labelledBy={TITLE_ID} frame class="w-full max-w-lg">
        <div class="flex flex-col gap-1 px-6 pt-6 pb-3">
          <h2 id={TITLE_ID} class="font-display text-text text-ui-md font-light">
            Starter checklist
          </h2>
          <p class="text-text-muted text-ui-sm leading-ui-snug">
            Each task is due a set time before your wedding date. Untick what does not fit; you can
            change or delete any task later.
          </p>
        </div>
        <div
          class="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-4"
          aria-busy={!preview() && !loadError()}
        >
          <Show when={loadError()}>
            <Notice tone="danger" alert>
              {loadError()}
            </Notice>
          </Show>
          <Show when={!preview() && !loadError()}>
            <output class="text-text-muted text-ui-sm block">Loading…</output>
          </Show>
          <Show when={preview()}>
            {(shown) => (
              <>
                <Show when={shown().weddingDate === null}>
                  <Notice tone="info">
                    {props.canManage
                      ? "Add your wedding date in Settings and these tasks get due dates. Until then they are added without one."
                      : "When an owner adds the wedding date in Settings, these tasks get due dates. Until then they are added without one."}
                  </Notice>
                </Show>
                <Show
                  when={groups().length > 0}
                  fallback={
                    <p class="text-text-muted text-ui-sm">
                      Everything in the starter checklist is already on yours.
                    </p>
                  }
                >
                  <For each={groups()}>
                    {(group) => (
                      <section class="flex flex-col gap-1">
                        <Eyebrow as="h3" tone="muted">
                          {group.label}
                        </Eyebrow>
                        <ul class="flex flex-col">
                          <For each={group.items}>{row}</For>
                        </ul>
                      </section>
                    )}
                  </For>
                </Show>
                <Show when={removed().length > 0}>
                  <section class="flex flex-col gap-1">
                    <Eyebrow as="h3" tone="muted">
                      You removed these earlier
                    </Eyebrow>
                    <ul class="flex flex-col">
                      <For each={removed()}>{row}</For>
                    </ul>
                  </section>
                </Show>
                <Show when={addedCount() > 0}>
                  <p class="text-text-muted text-ui-sm" data-numeric>
                    {addedCount()} already on your checklist.
                  </p>
                </Show>
              </>
            )}
          </Show>
        </div>
        <div class="border-border flex flex-col gap-3 border-t px-6 py-4">
          <Show when={applyError()}>
            <Notice tone="danger" alert>
              {applyError()}
            </Notice>
          </Show>
          <div class="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={close} disabled={busy()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void apply()}
              disabled={busy() || !preview() || count() === 0}
            >
              {busy() ? "Adding…" : `Add ${count()} ${count() === 1 ? "task" : "tasks"}`}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
