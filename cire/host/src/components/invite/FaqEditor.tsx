/**
 * The FAQ section's editor in the invite builder: the list of questions the
 * couple answers for their guests, with add, edit, delete and drag-to-reorder.
 *
 * Every change applies to the LIVE invite at once, like images and crops, and
 * unlike the copy, colours and section switches, which wait for Save. The FAQ's
 * own "Show on the invite" switch is in the section card around this editor and
 * saves with the rest.
 *
 * The list itself is owned by the builder (it drives the section's badge and
 * the preview); this component makes the API calls and reports each result back
 * through `onEntriesChange`.
 *
 * Two things here exist because of the page this sits in:
 *
 *  - The builder is one `<form>` whose submit saves the invite, so Enter in the
 *    question input would save the invite rather than the question. The entry
 *    form's container takes Enter from a single-line input and saves the entry
 *    instead; `preventDefault` there cancels the form's implicit submission.
 *  - The invite's write routes share one per-IP rate limit, and a keyboard walk
 *    moves a row once per key press. Moves are therefore shown at once and saved
 *    together: one `PUT /order` with the whole list, a short pause after the
 *    last move, one request in flight at a time.
 */

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
import { Notice } from "@shared/ui/ui/notice";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../../lib/api";
import { haptic } from "../../lib/haptics";
import ReorderControls from "../ReorderControls";
import { InstantBadge, TextAreaField, TextField } from "./fields";
import { FAQ_CAPS, type FaqEntry } from "./model";

/** How long after the last move the new order is saved. */
export const ORDER_SAVE_DELAY_MS = 400;

interface FaqEditorProps {
  weddingId: string;
  /** The entries in order, or `undefined` when the API predates the FAQ. */
  entries: FaqEntry[] | undefined;
  /** Receives the list after every change the editor makes. */
  onEntriesChange: (next: FaqEntry[]) => void;
  /** True while there is something here a navigation would lose: an entry
   *  form with typing in it, or a new order not yet saved. */
  onPendingChange: (pending: boolean) => void;
}

/** What the entry form is doing: adding a new entry, or editing one by id. */
type Editing = { kind: "new" } | { kind: "edit"; id: string };

/** The server's words for a refused write, when it sent any. */
async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error === "faq_limit_reached") {
    return `An invite can hold ${FAQ_CAPS.maxEntries} questions. Delete one to add another.`;
  }
  if (body.error === "faq_not_found") return "That question no longer exists. Reload the page.";
  return fallback;
}

export default function FaqEditor(props: FaqEditorProps) {
  const { authFetch } = useAuth();
  const base = () => `/api/organiser/weddings/${props.weddingId}/invite/faqs`;

  const entries = () => props.entries ?? [];
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [question, setQuestion] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const atCap = () => entries().length >= FAQ_CAPS.maxEntries;
  const editingId = () => {
    const e = editing();
    return e?.kind === "edit" ? e.id : null;
  };

  /** The text the open form started from, so an untouched form is not "pending". */
  const formStart = () => {
    const id = editingId();
    const entry = id ? entries().find((e) => e.id === id) : undefined;
    return { question: entry?.question ?? "", answer: entry?.answer ?? "" };
  };
  const formDirty = () =>
    editing() !== null && (question() !== formStart().question || answer() !== formStart().answer);

  // One list for the component's life: it holds the grips focus returns to and
  // the live region's text, so it must outlive every row.
  const ids = createMemo(() => entries().map((e) => e.id));
  const count = createMemo(() => entries().length);
  const reorder = createSortableList({
    ids,
    labelFor: (id) => untrack(() => entries().find((e) => e.id === id)?.question) ?? "question",
    noun: "question",
    onMove: (from, to) => move(from, to),
    onPhase: (phase) => haptic(phase),
  });

  // ── Order saving ───────────────────────────────────────────────────────────
  const sameOrder = (a: readonly string[], b: readonly string[] | null) =>
    b !== null && a.length === b.length && a.every((id, i) => id === b[i]);

  /** The order the server last acknowledged — what a failed save rolls back
   *  to. Taken from the first list the builder hands over. */
  let savedOrder: string[] | null = null;
  createEffect(() => {
    const list = props.entries;
    if (savedOrder === null && list !== undefined) savedOrder = list.map((e) => e.id);
  });
  let orderTimer: ReturnType<typeof setTimeout> | undefined;
  let orderInFlight = false;
  /** A move landed while a save was in flight; save again when it returns. */
  let orderStale = false;
  const [orderPending, setOrderPending] = createSignal(false);

  createEffect(() => props.onPendingChange(formDirty() || orderPending()));

  const sendOrder = (orderedIds: string[]) =>
    authFetch(apiUrl(`${base()}/order`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    });

  /** The current entries, put back into the last acknowledged order. Entries
   *  the server has not ordered yet (none, in practice) keep their place at the end. */
  const rollBackOrder = () => {
    const rank = new Map((savedOrder ?? []).map((id, i) => [id, i]));
    const last = rank.size;
    const restored = entries().toSorted(
      (a, b) => (rank.get(a.id) ?? last) - (rank.get(b.id) ?? last),
    );
    props.onEntriesChange(restored);
  };

  async function flushOrder() {
    orderTimer = undefined;
    if (orderInFlight) {
      orderStale = true;
      return;
    }
    const orderedIds = entries().map((e) => e.id);
    // Moved and moved back inside the pause: the server already has this order.
    if (sameOrder(orderedIds, savedOrder)) {
      setOrderPending(false);
      return;
    }
    orderInFlight = true;
    try {
      const res = await sendOrder(orderedIds);
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`order ${res.status}`);
      savedOrder = orderedIds;
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      reorder.clearAnnouncement();
      setError("Couldn't save the new order. It has been put back.");
      orderStale = false;
      rollBackOrder();
    } finally {
      orderInFlight = false;
      if (orderStale) {
        orderStale = false;
        void flushOrder();
      } else if (orderTimer === undefined) {
        setOrderPending(false);
      }
    }
  }

  function scheduleOrderSave() {
    setOrderPending(true);
    if (orderTimer !== undefined) clearTimeout(orderTimer);
    orderTimer = setTimeout(() => void flushOrder(), ORDER_SAVE_DELAY_MS);
  }

  // Leaving the builder inside the pause still saves the order the organiser
  // can see. Fire-and-forget: nothing is left mounted to report to.
  onCleanup(() => {
    if (orderTimer === undefined) return;
    clearTimeout(orderTimer);
    const orderedIds = entries().map((e) => e.id);
    if (!sameOrder(orderedIds, savedOrder)) void sendOrder(orderedIds).catch(() => {});
  });

  function move(from: number, to: number) {
    const list = entries();
    if (from === to || to < 0 || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setError(null);
    props.onEntriesChange(next);
    scheduleOrderSave();
  }

  // ── Focus ──────────────────────────────────────────────────────────────────
  // Opening, closing and deleting each remove the control that had focus (the
  // row swaps to its form, the form back to its row, the row goes), so focus
  // is put somewhere on purpose every time — the form's question when it
  // opens, and afterwards the control a keyboard user would reach for next.
  let root: HTMLDivElement | undefined;

  /** Focus the first match under the editor. Runs after the render the caller's
   *  state change caused, which Solid has already applied. */
  const focusIn = (selector: string) => root?.querySelector<HTMLElement>(selector)?.focus();

  /** The row's Edit button, or "Add a question" when that row is gone or the
   *  editor has no row to offer. */
  const focusAfterRow = (id: string | null) => {
    const edit = id
      ? root?.querySelector<HTMLElement>(`[data-faq-edit="${CSS.escape(id)}"]`)
      : null;
    if (edit) edit.focus();
    else focusIn("[data-faq-add]");
  };

  // ── Add, edit, delete ──────────────────────────────────────────────────────
  function openForm(next: Editing) {
    setError(null);
    const entry = next.kind === "edit" ? entries().find((e) => e.id === next.id) : undefined;
    setQuestion(entry?.question ?? "");
    setAnswer(entry?.answer ?? "");
    setEditing(next);
    focusIn("[data-faq-form] input");
  }

  function closeForm() {
    setEditing(null);
    setQuestion("");
    setAnswer("");
  }

  /** Cancel: back to the Edit button of the row that was being edited, or to
   *  "Add a question". */
  function cancelForm() {
    const id = editingId();
    closeForm();
    focusAfterRow(id);
  }

  const canSubmit = () => !busy() && question().trim().length > 0 && answer().trim().length > 0;

  async function submitEntry() {
    const target = editing();
    if (!target || !canSubmit()) return;
    setBusy(true);
    setError(null);
    // Where focus goes once the controls are enabled again, if the save lands.
    let focusRow: string | null | undefined;
    const body = JSON.stringify({ question: question(), answer: answer() });
    try {
      const res =
        target.kind === "new"
          ? await authFetch(apiUrl(base()), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            })
          : await authFetch(apiUrl(`${base()}/${encodeURIComponent(target.id)}`), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body,
            });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        haptic("reject");
        setError(await errorText(res, "Couldn't save that question."));
        return;
      }
      const { faq } = (await res.json()) as { faq: FaqEntry };
      if (target.kind === "new") {
        props.onEntriesChange([...entries(), faq]);
        savedOrder = [...(savedOrder ?? []), faq.id];
        toast.success("Question added");
        // Ready for the next question; at the cap there is no Add, so the new row.
        focusRow = atCap() ? faq.id : null;
      } else {
        props.onEntriesChange(entries().map((e) => (e.id === faq.id ? faq : e)));
        toast.success("Question saved");
        focusRow = faq.id;
      }
      haptic("commit");
      closeForm();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setError("Couldn't save that question.");
    } finally {
      setBusy(false);
      if (focusRow !== undefined) focusAfterRow(focusRow);
    }
  }

  async function deleteEntry(entry: FaqEntry) {
    // Deleting hits the live invite at once and has no undo, so it asks first.
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete “${entry.question}”? It disappears from your live invite immediately.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    // The row after the deleted one, or the one before it at the end of the list.
    const list = entries();
    const at = list.findIndex((e) => e.id === entry.id);
    const neighbour = (list[at + 1] ?? list[at - 1])?.id ?? null;
    let deleted = false;
    try {
      const res = await authFetch(apiUrl(`${base()}/${encodeURIComponent(entry.id)}`), {
        method: "DELETE",
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        haptic("reject");
        setError(await errorText(res, "Couldn't delete that question."));
        return;
      }
      props.onEntriesChange(entries().filter((e) => e.id !== entry.id));
      savedOrder = (savedOrder ?? []).filter((id) => id !== entry.id);
      if (editingId() === entry.id) closeForm();
      haptic("commit");
      toast.success("Question deleted");
      deleted = true;
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setError("Couldn't delete that question.");
    } finally {
      setBusy(false);
      if (deleted) focusAfterRow(neighbour);
    }
  }

  /** Enter in the single-line question input saves the entry, not the invite. */
  function onFormKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    void submitEntry();
  }

  const entryForm = () => (
    <div
      data-faq-form
      class="border-border bg-surface/20 flex flex-col gap-3 rounded-sm border p-3"
      onKeyDown={onFormKeyDown}
    >
      <TextField
        label="Question"
        placeholder="Is there parking at the venue?"
        value={question()}
        maxLength={FAQ_CAPS.question}
        onInput={setQuestion}
      />
      <TextAreaField
        label="Answer"
        rows={4}
        placeholder="Yes — the venue has free parking for about sixty cars."
        value={answer()}
        maxLength={FAQ_CAPS.answer}
        onInput={setAnswer}
      />
      <div class="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={!canSubmit()}
          onClick={() => void submitEntry()}
        >
          {busy() ? "Saving…" : editing()?.kind === "new" ? "Add question" : "Save question"}
        </Button>
        <Button variant="subtle" size="sm" type="button" disabled={busy()} onClick={cancelForm}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Show
      when={props.entries !== undefined}
      fallback={
        <Notice tone="info">
          Questions can't be edited yet — the invite service is still being updated. Reload the page
          in a few minutes.
        </Notice>
      }
    >
      <div ref={root} class="flex flex-col gap-3" data-faq-editor>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="font-body text-text-muted text-ui-sm">
            {count() === 0 ? "No questions yet." : `${count()} of ${FAQ_CAPS.maxEntries} questions`}
          </span>
          <InstantBadge />
        </div>

        <Show when={error()}>
          <Notice tone="danger" alert>
            {error()}
          </Notice>
        </Show>

        <Show when={count() > 0}>
          <DragDropProvider {...reorder.dragHandlers} collisionDetector={closestCenter}>
            <DragDropSensors />
            <ul class="flex flex-col gap-2" aria-label="Questions">
              <SortableProvider ids={ids()}>
                <For each={entries()}>
                  {(entry, i) => {
                    const sortable = createSortable(entry.id);
                    // Non-null: rendered inside the DragDropProvider above.
                    const [dndState] = useDragDropContext()!;
                    const sortableItem = reorder.item(entry.id, i, count);
                    return (
                      <li
                        ref={sortable.ref}
                        data-faq-entry={entry.id}
                        style={maybeTransformStyle(sortable.transform())}
                        class="border-border bg-surface/10 relative flex flex-col gap-2 rounded-sm border px-3 py-2"
                        classList={{
                          "border-gold/60 bg-surface/80 z-10 shadow-lg":
                            sortable.isActiveDraggable(),
                          "transition-transform":
                            !!dndState.active().draggable && !sortable.isActiveDraggable(),
                        }}
                      >
                        <Show
                          when={editingId() === entry.id}
                          fallback={
                            <div class="flex items-start gap-3">
                              <ReorderControls sortable={sortable} item={sortableItem} />
                              <div class="flex min-w-0 flex-1 flex-col gap-1">
                                <p class="font-body text-text text-ui-base break-words">
                                  {entry.question}
                                </p>
                                <p class="font-body text-text-muted text-ui-sm line-clamp-2 break-words whitespace-pre-line">
                                  {entry.answer}
                                </p>
                              </div>
                              <div class="flex shrink-0 items-center gap-1">
                                <Button
                                  variant="subtle"
                                  size="sm"
                                  type="button"
                                  disabled={busy()}
                                  aria-label={`Edit “${entry.question}”`}
                                  data-faq-edit={entry.id}
                                  onClick={() => openForm({ kind: "edit", id: entry.id })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="bareDanger"
                                  type="button"
                                  disabled={busy()}
                                  aria-label={`Delete “${entry.question}”`}
                                  onClick={() => void deleteEntry(entry)}
                                >
                                  Delete
                                </Button>
                              </div>
                            </div>
                          }
                        >
                          {entryForm()}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </SortableProvider>
            </ul>
          </DragDropProvider>
          <p {...reorder.hintProps()}>{reorder.hintText}</p>
          <p {...reorder.liveRegionProps()}>{reorder.announcement()}</p>
        </Show>

        <Show
          when={editing()?.kind === "new"}
          fallback={
            <Show
              when={!atCap()}
              fallback={
                <p class="font-body text-text-muted text-ui-sm">
                  That's the most an invite can hold — {FAQ_CAPS.maxEntries} questions. Delete one
                  to add another.
                </p>
              }
            >
              <Button
                variant="dashed"
                size="sm"
                type="button"
                class="self-start"
                disabled={busy() || editing() !== null}
                data-faq-add
                onClick={() => openForm({ kind: "new" })}
              >
                Add a question
              </Button>
            </Show>
          }
        >
          {entryForm()}
        </Show>
      </div>
    </Show>
  );
}
