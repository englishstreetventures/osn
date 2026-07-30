import { useAuth } from "@shared/rp-auth/solid";
import {
  closestCenter,
  createSortable,
  DragDropProvider,
  DragDropSensors,
  type DragEvent as SortableDragEvent,
  maybeTransformStyle,
  SortableProvider,
  useDragDropContext,
} from "@thisbeyond/solid-dnd";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { joinIso, OFFSET_OPTIONS, splitIso } from "../lib/event-datetime";
import {
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  invalidateEvents,
} from "../lib/events-store";
import { createGuestEventDraft, type DraftEvent } from "../lib/guest-event-draft";
import {
  ensureGuestsLoaded,
  guestsAccessor,
  invalidateGuests,
  type OrganiserGuestRow,
} from "../lib/guests-store";
import ChangePreview, { type ChangePlan } from "./ChangePreview";
import ColorPicker from "./ColorPicker";
import DatePicker from "./DatePicker";
import SectionIntro from "./SectionIntro";

interface PreviewResponse {
  changeId: string;
  plan: ChangePlan;
  warnings: string[];
  baseRevision: string;
}

/** Stand-in for a not-yet-named event. Deliberately the same string the row
 *  displays, so a grip's label, the move announcement and the visible row all
 *  call a blank event by the same name. */
const UNNAMED_EVENT = "Untitled event";

/**
 * The Events EDITOR (guest+event editor E6, §8). A re-orderable list of events
 * on top of the SHARED draft store (the same one the Guests editor uses — E6
 * mutates the `events` slice E5 carried through untouched). Add/edit an event
 * via a drawer form (name, start/end + timezone, address, dress-code + palette
 * reusing {@link ColorPicker}, Pinterest/Maps URLs); delete with an impact
 * confirm; re-order by DRAGGING a row's grip handle (solid-dnd), writing
 * `sortOrder`. Save posts the WHOLE draft (events + families) as DesiredState
 * JSON to `changes/preview` → the shared {@link ChangePreview} modal →
 * `changes/apply` on confirm → refetch + toast.
 *
 * Field-invalid drafts can't be submitted — Save disables and the drawer shows
 * errors inline. Guests ride along unchanged (id-matched ⇒ no-op update).
 *
 * Re-ordering has THREE input paths, and all three are load-bearing. solid-dnd
 * ships a pointer sensor only — no keyboard sensor, no announcements — so on top
 * of dragging the grip handles Arrow Up/Down itself, each row carries `sr-only`
 * move buttons (NVDA/JAWS browse mode never forwards the grip's arrow keys, so
 * without an Enter/Space-activated path those users have none), and every move is
 * reported through a polite live region. That's what stops "drag instead of ▲/▼
 * buttons" from being an accessibility regression — see
 * `[[cire/wiki/architecture/drag-and-drop]]` before removing any of it.
 */
export default function EventsEditor(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  const store = createGuestEventDraft();

  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<PreviewResponse | null>(null);
  /** The draft key of the event whose drawer is open, or null when closed. */
  const [editingKey, setEditingKey] = createSignal<string | null>(null);

  /** Live-region text announcing the last re-order. solid-dnd announces nothing,
   *  so without this a keyboard/screen-reader user gets no feedback that the move
   *  landed. */
  const [announcement, setAnnouncement] = createSignal("");

  /** The draft keys in current schedule order — `SortableProvider`'s id list, and
   *  what a drop's draggable/droppable ids are resolved against. */
  const eventKeys = createMemo(() => store.draft.events.map((e) => e.key));

  function announceMove(name: string, to: number) {
    // Clear FIRST. A live region only re-announces when its text actually
    // changes, and walking one row down the list repeatedly produces the same
    // sentence every time ("X moved to position 2 of 3") — set straight, the
    // signal's `===` equality would drop it and the second press would be
    // silent. Solid applies each set synchronously, so this is two real DOM
    // writes: empty, then the message.
    setAnnouncement("");
    setAnnouncement(
      `${name || UNNAMED_EVENT} moved to position ${to + 1} of ${store.draft.events.length}.`,
    );
  }

  /** Undo/discard rewind the order without going through `announceMove`, so the
   *  region would otherwise keep asserting a move that has just been reversed.
   *  Cleared rather than re-announced: an undo may have reverted a field edit
   *  rather than a re-order, and guessing which would be worse than silence. */
  const clearAnnouncement = () => setAnnouncement("");

  /** Commit a drop. solid-dnd hands back the dragged row and the row it landed
   *  on; both ids are draft keys, so the move is their two indices in the current
   *  order. `reorderEvents` itself no-ops on same-index/out-of-range. */
  function handleDragEnd({ draggable, droppable }: SortableDragEvent) {
    if (!droppable) return;
    const keys = eventKeys();
    const from = keys.indexOf(String(draggable.id));
    const to = keys.indexOf(String(droppable.id));
    if (from === -1 || to === -1 || from === to) return;
    const name = store.draft.events[from]?.name ?? "";
    store.reorderEvents(from, to);
    announceMove(name, to);
  }

  /** Keyboard re-order: move the row at `index` one slot in `delta`'s direction.
   *  Focus rides along for free — `<For>` is keyed, so the row's DOM node (and
   *  the focused grip inside it) is MOVED rather than re-created. */
  function handleKeyboardMove(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= store.draft.events.length) return;
    const name = store.draft.events[index]?.name ?? "";
    store.reorderEvents(index, to);
    announceMove(name, to);
  }

  const changesUrl = (op: string) =>
    apiUrl(`/api/organiser/weddings/${props.weddingId}/changes/${op}`);

  /** Load events + guests through the shared caches, then seed the draft. Guests
   *  are loaded even though this tab only edits events: the draft-save posts the
   *  WHOLE DesiredState, so an unloaded guest slice would read as "delete every
   *  household". */
  async function loadInto() {
    const [events, guests] = await Promise.all([
      ensureEventsLoaded(props.weddingId, async () => {
        const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/events`));
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("unauthenticated");
        }
        if (!res.ok) throw new Error("Failed to load events");
        return (await res.json()) as EventRow[];
      }).then(() => eventsAccessor(props.weddingId)() ?? []),
      ensureGuestsLoaded(props.weddingId, async () => {
        const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/guests`));
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("unauthenticated");
        }
        if (!res.ok) throw new Error("Failed to load guests");
        return (await res.json()) as OrganiserGuestRow[];
      }).then(() => guestsAccessor(props.weddingId)() ?? []),
    ]);
    store.load(events, guests);
  }

  onMount(async () => {
    try {
      await loadInto();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setLoadError("Could not load the schedule. Is the API running?");
    }
  });

  /** Field errors indexed by the offending event's draft key, for the drawer. */
  const errorsByKey = createMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of store.errors()) {
      const list = map.get(e.key) ?? [];
      list.push(e.message);
      map.set(e.key, list);
    }
    return map;
  });

  const hasErrors = () => store.errors().length > 0;

  const editingEvent = (): DraftEvent | null =>
    store.draft.events.find((e) => e.key === editingKey()) ?? null;

  function handleAdd() {
    const key = store.addEvent();
    setEditingKey(key);
  }

  function handleDelete(evt: DraftEvent) {
    const ok = window.confirm(
      `Delete "${evt.name || "this event"}"? Any RSVPs for it are discarded and its uploaded image is removed. You'll confirm the full impact before it's applied.`,
    );
    if (!ok) return;
    store.removeEvent(evt.key);
    if (editingKey() === evt.key) setEditingKey(null);
  }

  async function handleSave() {
    if (hasErrors() || !store.dirty()) return;
    setSaveError(null);
    setBusy(true);
    try {
      const res = await authFetch(changesUrl("preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desiredState: store.toWire() }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Preview failed (${res.status})`);
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setSaveError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    const p = preview();
    if (!p) return;
    setSaveError(null);
    setBusy(true);
    try {
      const res = await authFetch(changesUrl("apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeId: p.changeId, importId: p.changeId }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // 409 = a co-host applied in between; the previewed diff is stale.
        if (res.status === 409) {
          throw new Error("The schedule changed elsewhere. Re-open Save to preview afresh.");
        }
        throw new Error(body.error ?? `Apply failed (${res.status})`);
      }
      invalidateEvents(props.weddingId);
      invalidateGuests(props.weddingId);
      setPreview(null);
      setEditingKey(null);
      await loadInto();
      store.commit();
      toast.success("Schedule saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setSaveError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-8 pb-24">
      <SectionIntro
        eyebrow="Schedule"
        title="Edit your events"
        description="Add the events your guests can be invited to, drag them by the grip to re-order, set the details, and save. Every change is previewed before it's applied — you'll see exactly what will change, including anything that affects RSVPs or images."
        actions={
          <Show when={store.loaded()}>
            <button
              type="button"
              onClick={handleAdd}
              class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition"
            >
              Add event
            </button>
          </Show>
        }
      />

      <Show when={loadError()}>
        <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
          {loadError()}
        </p>
      </Show>

      <Show when={!store.loaded() && !loadError()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3]}>
            {() => <div class="bg-surface h-[72px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={store.loaded()}>
        <Show
          when={store.draft.events.length > 0}
          fallback={
            <div class="border-border bg-surface/30 flex flex-col items-start gap-2 rounded-sm border border-dashed p-8 text-center">
              <p class="font-display text-gold-dim w-full text-[1.2rem]">No events yet</p>
              <p class="font-body text-text-muted w-full text-[0.85rem]">
                Add an event to start building your schedule. Guests are matched to events that
                exist.
              </p>
            </div>
          }
        >
          {/* `DragDropSensors` registers solid-dnd's pointer sensor; the grip's own
              Arrow-key handler covers keyboard (solid-dnd has no keyboard sensor).
              `closestCenter` is the right detector for a single-column list. */}
          <DragDropProvider onDragEnd={handleDragEnd} collisionDetector={closestCenter}>
            <DragDropSensors />
            <ul class="flex flex-col gap-3" data-testid="event-list">
              <SortableProvider ids={eventKeys()}>
                <For each={store.draft.events}>
                  {(event, index) => (
                    <EventRowCard
                      event={event}
                      index={index()}
                      count={store.draft.events.length}
                      hasError={(errorsByKey().get(event.key)?.length ?? 0) > 0}
                      onEdit={() => setEditingKey(event.key)}
                      onDelete={() => handleDelete(event)}
                      onKeyboardMove={(delta) => handleKeyboardMove(index(), delta)}
                    />
                  )}
                </For>
              </SortableProvider>
            </ul>
          </DragDropProvider>

          {/* Keyboard instructions, referenced by every grip's aria-describedby —
              the drag affordance is invisible to a screen-reader user otherwise. */}
          <p id="reorder-hint" class="sr-only">
            Drag to re-order, or press the up and down arrow keys to move this event. Move up and
            move down buttons follow this handle.
          </p>
          {/* Screen-reader feedback for a completed move (drag or keyboard). */}
          <p class="sr-only" role="status" aria-live="polite">
            {announcement()}
          </p>
        </Show>
      </Show>

      {/* Drawer form for the event being edited/added. */}
      <Show when={editingEvent()}>
        {(evt) => (
          <EventDrawer
            event={evt()}
            errors={errorsByKey().get(evt().key) ?? []}
            onPatch={(patch) => store.updateEvent(evt().key, patch)}
            onClose={() => setEditingKey(null)}
          />
        )}
      </Show>

      {/* Preview modal (the shared ChangePreview). */}
      <Show when={preview()}>
        {(p) => (
          /* Portalled to document.body: the dashboard shell sets `container-type`
             on its layout boxes, which brings `contain: layout` with it and makes
             them the containing block for `position: fixed` descendants. */
          <Portal>
            <div
              class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              role="dialog"
              aria-modal="true"
              aria-label="Review changes before applying"
            >
              <div class="bg-bg border-border max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-sm border p-6 shadow-xl">
                <ChangePreview
                  plan={p().plan}
                  warnings={p().warnings}
                  busy={busy()}
                  confirmLabel="Confirm & save"
                  onConfirm={() => void handleApply()}
                  onCancel={() => setPreview(null)}
                />
              </div>
            </div>
          </Portal>
        )}
      </Show>

      {/* Sticky unsaved-changes bar (§8) — only while dirty. */}
      <Show when={store.loaded() && store.dirty()}>
        {/* Portalled for the same containment reason as the preview modal above —
            a `fixed` bar inside a `container-type` box pins to that box, not the
            viewport, so it would ride inside the panel instead of the window. */}
        <Portal>
          <div class="border-border bg-surface/95 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur">
            <div class="page-frame flex flex-wrap items-center justify-between gap-3 py-3">
              <span class="font-body text-text-muted text-[0.82rem]">
                <Show when={hasErrors()} fallback="You have unsaved changes.">
                  <span class="text-error">
                    Fix {store.errors().length} {store.errors().length === 1 ? "error" : "errors"}{" "}
                    before saving.
                  </span>
                </Show>
              </span>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    store.undo();
                    clearAnnouncement();
                  }}
                  disabled={!store.canUndo() || busy()}
                  class="font-body text-text-muted hover:text-gold border-border rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    store.discard();
                    clearAnnouncement();
                    setEditingKey(null);
                  }}
                  disabled={busy()}
                  class="font-body text-text-muted hover:text-error border-border rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                >
                  Discard changes
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={busy() || hasErrors()}
                  class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-4 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                >
                  {busy() ? "Working…" : "Save changes"}
                </button>
              </div>
            </div>
            <Show when={store.warnings().length > 0 && !hasErrors()}>
              <p class="border-gold/20 bg-gold/5 text-gold-dim page-frame border-t py-2 text-[0.82rem]">
                {store.warnings().join(" ")}
              </p>
            </Show>
            <Show when={saveError()}>
              <p class="border-error/20 bg-error/5 text-error page-frame border-t py-2 text-[0.82rem]">
                {saveError()}
              </p>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

/** One event summary row: a drag handle to re-order, plus edit/delete controls.
 *  Must be rendered inside the list's `DragDropProvider` + `SortableProvider`. */
function EventRowCard(props: {
  event: DraftEvent;
  index: number;
  count: number;
  hasError: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onKeyboardMove: (delta: -1 | 1) => void;
}) {
  const sortable = createSortable(props.event.key);
  // Non-null: the row only ever renders inside the list's DragDropProvider.
  const [dndState] = useDragDropContext()!;
  let handleEl!: HTMLButtonElement;

  /** Arrow Up/Down re-orders from the focused grip — solid-dnd has no keyboard
   *  sensor, so this is the whole keyboard story for the list. */
  function handleKeyDown(event: KeyboardEvent) {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (delta === 0) return;
    // Stop the page scrolling out from under the row being moved. Deliberately
    // BEFORE the bounds check, so a focused grip owns Up/Down unconditionally:
    // at either end of the list the key does nothing at all rather than
    // sometimes moving the row and sometimes scrolling the page.
    event.preventDefault();
    // One press, one move — matching the click semantics of the ▲/▼ buttons this
    // replaced. Auto-repeat fires ~30×/s and every move is a full draft
    // checkpoint (a structuredClone) plus a revalidation, so a held key would
    // stall the list AND burn through the 100-slot undo stack in a few seconds,
    // silently dropping the edits the organiser actually wants to undo.
    if (event.repeat) return;
    props.onKeyboardMove(delta);
    // Re-focus the grip explicitly. `<For>` is keyed so this very node is MOVED
    // rather than re-created, but a DOM move is a remove-then-insert and focus
    // does not reliably survive it — without this, one keypress moves the row and
    // then focus is on <body>, so the row can't be walked further.
    handleEl.focus();
  }

  /** One screen-reader move control. Activated with Enter/Space (or an AT's
   *  "activate" command), so it works from browse mode where the grip's arrow
   *  keys don't reach. Disabled at the list ends rather than silently no-op, so
   *  AT reports the boundary instead of the user pressing into nothing. */
  const moveButton = (delta: -1 | 1) => {
    const atEnd = () => (delta === -1 ? props.index === 0 : props.index === props.count - 1);
    return (
      <button
        type="button"
        disabled={atEnd()}
        onClick={() => props.onKeyboardMove(delta)}
        class="border-border bg-surface font-body text-text-muted hover:text-gold sr-only rounded-sm border px-2 py-1 text-[0.7rem] tracking-[0.1em] uppercase focus:not-sr-only focus:relative focus:z-20"
      >
        Move {props.event.name || UNNAMED_EVENT} {delta === -1 ? "up" : "down"}
      </button>
    );
  };

  return (
    <li
      ref={sortable.ref}
      // `ref` (unlike solid-dnd's `use:sortable` directive) registers the node
      // WITHOUT applying the drag/shift transform, which is what lets the grip —
      // rather than the whole row — be the drag affordance. So apply it here.
      style={maybeTransformStyle(sortable.transform)}
      class="border-border bg-surface/30 flex flex-wrap items-center gap-3 rounded-sm border p-4"
      classList={{
        "border-error/50": props.hasError,
        // Lift the row being dragged clear of its neighbours.
        "border-gold/60 bg-surface/80 z-10 shadow-lg": sortable.isActiveDraggable,
        // Animate the OTHER rows shifting aside, but never the dragged one —
        // that must track the pointer without easing. Only while a drag is live,
        // so the post-drop settle isn't double-animated.
        "transition-transform": !!dndState.active.draggable && !sortable.isActiveDraggable,
      }}
    >
      {/* Re-order controls: a grip you drag, plus two activate-to-move buttons
          that are only rendered for assistive tech. See `moveButton` below for
          why the second path is NOT redundant. `touch-none` on the grip is
          required — without it the browser scrolls instead of handing the
          gesture to solid-dnd. */}
      <div class="flex items-center">
        <button
          type="button"
          ref={handleEl}
          aria-label={`Reorder ${props.event.name || UNNAMED_EVENT}, position ${props.index + 1} of ${props.count}`}
          aria-describedby="reorder-hint"
          // Spread FIRST so our keyboard handler can't be clobbered by a future
          // solid-dnd sensor that also binds keydown.
          {...sortable.dragActivators}
          onKeyDown={handleKeyDown}
          // `py-2` is not decoration: it brings the handle to the WCAG 2.5.8
          // 24px minimum target, on the row's only re-order affordance.
          class="text-text-muted hover:text-gold focus-visible:text-gold cursor-grab touch-none px-1 py-2 text-[1.1rem] leading-none active:cursor-grabbing"
        >
          ⠿
        </button>

        {/* The arrow-key handler on the grip above is NOT enough on its own:
            NVDA and JAWS run in browse mode by default and consume unmodified
            arrow keys for their own virtual cursor, forwarding them to a plain
            <button> only in focus mode (which buttons don't trigger). Those
            users would read the hint, press the arrows and get nothing. The
            ▲/▼ buttons this list replaced were Enter/Space-activated, which
            browse mode DOES forward — so without these the swap to dragging is
            a straight regression for screen-reader users. Visually hidden, but
            revealed on focus so a sighted keyboard user never lands on an
            invisible control (WCAG 2.4.7). */}
        <span class="flex flex-col">
          {moveButton(-1)}
          {moveButton(1)}
        </span>
      </div>

      <div class="min-w-0 flex-1">
        <p class="font-display text-text truncate text-[1.15rem]">
          {props.event.name || <span class="text-text-muted not-italic">{UNNAMED_EVENT}</span>}
        </p>
        <p class="font-body text-text-muted truncate text-[0.8rem]">
          <Show when={props.event.startAt} fallback="No start time set">
            {props.event.startAt}
          </Show>
          {props.event.timezone ? ` · ${props.event.timezone}` : ""}
        </p>
        <Show when={props.hasError}>
          <p class="text-error text-[0.76rem]">This event has errors — open it to fix them.</p>
        </Show>
        <Show when={props.event.id === null}>
          <span class="font-body text-gold/70 border-gold/30 mt-1 inline-block rounded-sm border px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase">
            New — saved on apply
          </span>
        </Show>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          onClick={props.onEdit}
          class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-3 py-1.5 text-[0.7rem] tracking-[0.1em] uppercase transition"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={props.onDelete}
          class="font-body text-text-muted hover:text-error hover:border-error/60 border-border rounded-sm border px-3 py-1.5 text-[0.7rem] tracking-[0.1em] uppercase transition-colors"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

const fieldLabel = "font-body text-text-muted text-[0.66rem] tracking-[0.14em] uppercase";
const fieldInput =
  "border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-1.5 text-[0.9rem] outline-none";

/** The add/edit drawer — a right-hand panel with the full event form. Every
 *  field writes straight through to the draft (no local staging), so undo/
 *  discard on the sticky bar reach these edits too. */
function EventDrawer(props: {
  event: DraftEvent;
  errors: string[];
  onPatch: (patch: Parameters<ReturnType<typeof createGuestEventDraft>["updateEvent"]>[1]) => void;
  onClose: () => void;
}) {
  const start = () => splitIso(props.event.startAt);
  const end = () => splitIso(props.event.endAt);

  const setStart = (part: "date" | "time" | "offset", value: string | null) => {
    const next = { ...start(), [part]: value ?? "" };
    props.onPatch({ startAt: joinIso(next) });
  };
  const setEnd = (part: "date" | "time" | "offset", value: string | null) => {
    // An end with a cleared date/time collapses to "" (open-ended), which the
    // validator + parser accept as "no stated end".
    const next = { ...end(), [part]: value ?? "" };
    props.onPatch({ endAt: joinIso(next) });
  };

  const addSwatch = () =>
    props.onPatch({
      dressCodePalette: [...props.event.dressCodePalette, { name: "", color: "#d4af37" }],
    });
  const updateSwatch = (i: number, patch: { name?: string; color?: string | null }) => {
    const next = props.event.dressCodePalette.map((s, idx) =>
      idx === i ? { name: patch.name ?? s.name, color: patch.color ?? s.color } : s,
    );
    props.onPatch({ dressCodePalette: next });
  };
  const removeSwatch = (i: number) =>
    props.onPatch({
      dressCodePalette: props.event.dressCodePalette.filter((_, idx) => idx !== i),
    });

  return (
    /* Portalled: see the preview modal above — `container-type` on the shell
       makes it the containing block for `position: fixed` descendants. */
    <Portal>
      <div class="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={props.onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit event"
          class="bg-bg border-border h-full w-full max-w-md overflow-y-auto border-l p-6 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="mb-6 flex items-center justify-between">
            <h2 class="font-display text-gold-dim text-[1.4rem]">Event details</h2>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close"
              class="text-text-muted hover:text-text text-[1.2rem]"
            >
              ✕
            </button>
          </div>

          <Show when={props.errors.length > 0}>
            <div class="border-error/20 bg-error/5 mb-5 flex flex-col gap-1 rounded-sm border p-3">
              <For each={props.errors}>
                {(msg) => <p class="text-error text-[0.8rem]">{msg}</p>}
              </For>
            </div>
          </Show>

          <div class="flex flex-col gap-5">
            <label class="flex flex-col gap-1.5">
              <span class={fieldLabel}>Event name</span>
              <input
                type="text"
                value={props.event.name}
                aria-label="Event name"
                onInput={(e) => props.onPatch({ name: e.currentTarget.value })}
                class={fieldInput}
              />
            </label>

            {/* Start: date + time + offset. */}
            <fieldset class="flex flex-col gap-2 border-none p-0">
              <legend class={fieldLabel}>Start</legend>
              <DatePicker
                label="Start date"
                value={start().date || null}
                onChange={(v) => setStart("date", v)}
              />
              <div class="flex flex-wrap items-end gap-3">
                <label class="flex flex-col gap-1.5">
                  <span class={fieldLabel}>Time</span>
                  <input
                    type="time"
                    value={start().time}
                    aria-label="Start time"
                    onInput={(e) => setStart("time", e.currentTarget.value)}
                    class={fieldInput}
                  />
                </label>
                <label class="flex flex-col gap-1.5">
                  <span class={fieldLabel}>UTC offset</span>
                  <select
                    value={start().offset}
                    aria-label="Start UTC offset"
                    onChange={(e) => setStart("offset", e.currentTarget.value)}
                    class={fieldInput}
                  >
                    <For each={OFFSET_OPTIONS}>{(o) => <option value={o}>{o}</option>}</For>
                  </select>
                </label>
              </div>
            </fieldset>

            {/* End (optional). */}
            <fieldset class="flex flex-col gap-2 border-none p-0">
              <legend class={fieldLabel}>End (optional)</legend>
              <DatePicker
                label="End date"
                value={end().date || null}
                onChange={(v) => setEnd("date", v)}
              />
              <div class="flex flex-wrap items-end gap-3">
                <label class="flex flex-col gap-1.5">
                  <span class={fieldLabel}>Time</span>
                  <input
                    type="time"
                    value={end().time}
                    aria-label="End time"
                    onInput={(e) => setEnd("time", e.currentTarget.value)}
                    class={fieldInput}
                  />
                </label>
                <label class="flex flex-col gap-1.5">
                  <span class={fieldLabel}>UTC offset</span>
                  <select
                    value={end().offset}
                    aria-label="End UTC offset"
                    onChange={(e) => setEnd("offset", e.currentTarget.value)}
                    class={fieldInput}
                  >
                    <For each={OFFSET_OPTIONS}>{(o) => <option value={o}>{o}</option>}</For>
                  </select>
                </label>
              </div>
            </fieldset>

            <label class="flex flex-col gap-1.5">
              <span class={fieldLabel}>Timezone (IANA name)</span>
              <input
                type="text"
                value={props.event.timezone}
                aria-label="Timezone"
                placeholder="Australia/Sydney"
                onInput={(e) => props.onPatch({ timezone: e.currentTarget.value })}
                class={fieldInput}
              />
            </label>

            <label class="flex flex-col gap-1.5">
              <span class={fieldLabel}>Address</span>
              <input
                type="text"
                value={props.event.address ?? ""}
                aria-label="Address"
                onInput={(e) =>
                  props.onPatch({
                    address: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                  })
                }
                class={fieldInput}
              />
            </label>

            <label class="flex flex-col gap-1.5">
              <span class={fieldLabel}>Dress code description</span>
              <textarea
                value={props.event.dressCodeDescription ?? ""}
                aria-label="Dress code description"
                rows={2}
                onInput={(e) =>
                  props.onPatch({
                    dressCodeDescription:
                      e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                  })
                }
                class={fieldInput}
              />
            </label>

            {/* Dress-code palette — each swatch a name + a ColorPicker. */}
            <div class="flex flex-col gap-2">
              <span class={fieldLabel}>Dress code palette</span>
              <For each={props.event.dressCodePalette}>
                {(swatch, i) => (
                  <div class="flex flex-wrap items-end gap-2">
                    <label class="flex flex-1 flex-col gap-1.5">
                      <span class="sr-only">Swatch name</span>
                      <input
                        type="text"
                        value={swatch.name}
                        aria-label={`Swatch ${i() + 1} name`}
                        placeholder="Blush"
                        onInput={(e) => updateSwatch(i(), { name: e.currentTarget.value })}
                        class={fieldInput}
                      />
                    </label>
                    <ColorPicker
                      label={`Swatch ${i() + 1} colour`}
                      value={swatch.color}
                      onChange={(c) => updateSwatch(i(), { color: c })}
                    />
                    <button
                      type="button"
                      onClick={() => removeSwatch(i())}
                      aria-label={`Remove swatch ${i() + 1}`}
                      class="font-body text-text-muted hover:text-error text-[0.72rem] tracking-[0.1em] uppercase"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </For>
              <button
                type="button"
                onClick={addSwatch}
                class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 self-start rounded-sm border px-3 py-1.5 text-[0.7rem] tracking-[0.1em] uppercase transition"
              >
                Add swatch
              </button>
            </div>

            <label class="flex flex-col gap-1.5">
              <span class={fieldLabel}>Pinterest URL</span>
              <input
                type="url"
                value={props.event.pinterestUrl ?? ""}
                aria-label="Pinterest URL"
                placeholder="https://www.pinterest.com/…"
                onInput={(e) =>
                  props.onPatch({
                    pinterestUrl: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                  })
                }
                class={fieldInput}
              />
            </label>

            <label class="flex flex-col gap-1.5">
              <span class={fieldLabel}>Maps URL</span>
              <input
                type="url"
                value={props.event.mapsUrl ?? ""}
                aria-label="Maps URL"
                placeholder="https://maps.google.com/…"
                onInput={(e) =>
                  props.onPatch({
                    mapsUrl: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                  })
                }
                class={fieldInput}
              />
            </label>

            <button
              type="button"
              onClick={props.onClose}
              class="border-gold bg-gold font-body text-bg hover:bg-gold-dim mt-2 self-start rounded-sm border px-4 py-2 text-[0.78rem] tracking-[0.1em] uppercase transition"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
