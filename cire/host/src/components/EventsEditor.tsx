import { useAuth } from "@shared/rp-auth/solid";
import {
  closestCenter,
  createSortable,
  createSortableList,
  DragDropProvider,
  DragDropSensors,
  type Id,
  maybeTransformStyle,
  type SortableItem,
  SortableProvider,
  useDragDropContext,
} from "@shared/sortable";
import { toast } from "@shared/toast";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { type DateTimeParts, joinIso, splitIso } from "../lib/event-datetime";
import { formatEventWhen } from "../lib/event-display";
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
import { haptic } from "../lib/haptics";
import {
  ensureHouseholdsLoaded,
  householdsAccessor,
  invalidateHouseholds,
  type OrganiserHouseholdRow,
} from "../lib/households-store";
import { describeTimeZone, timeZoneGroups, zoneOffset } from "../lib/timezones";
import { registerUnsavedGuard } from "../lib/unsaved-guard";
import ChangePreview, { type ChangePlan } from "./ChangePreview";
import ColorPicker from "./ColorPicker";
import DatePicker from "./DatePicker";
import SectionIntro from "./SectionIntro";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import Field, { Fieldset, Input, Select, Textarea } from "./ui/Field";
import Notice from "./ui/Notice";

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
 * confirm; re-order by DRAGGING a row's grip handle (`@shared/sortable`), writing
 * `sortOrder`. Save posts the WHOLE draft (events + families) as DesiredState
 * JSON to `changes/preview` → the shared {@link ChangePreview} modal →
 * `changes/apply` on confirm → refetch + toast.
 *
 * Field-invalid drafts can't be submitted — Save disables and the drawer shows
 * errors inline. Guests ride along unchanged (id-matched ⇒ no-op update).
 *
 * Re-ordering has THREE input paths, and all three are load-bearing: dragging
 * the grip, Arrow Up/Down from the focused grip, and per-row `sr-only` move
 * buttons (NVDA/JAWS browse mode never forwards the grip's arrow keys, so
 * without an Enter/Space-activated path those users have none). Every move is
 * reported through a polite live region. That's what stops "drag instead of ▲/▼
 * buttons" from being an accessibility regression.
 *
 * All three now come from `createSortableList` in `@shared/sortable`, which
 * owns and tests the five obligations that make them work — see its docblock,
 * and `wiki/architecture/drag-and-drop.md`, before changing any of it.
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

  /** The draft keys in current schedule order — `SortableProvider`'s id list, and
   *  what a drop's draggable/droppable ids are resolved against. */
  const eventKeys = createMemo(() => store.draft.events.map((e) => e.key));

  const nameForKey = (key: Id) =>
    store.draft.events.find((e) => e.key === key)?.name || UNNAMED_EVENT;

  /**
   * The whole keyboard / screen-reader / announcement layer, owned by
   * `@shared/sortable`.
   *
   * It used to live here — about 120 lines of it — because the drag library
   * supplied none of it: no keyboard sensor, no announcements. Every list that
   * wanted dragging had to re-derive the same five obligations, which is why
   * `ChecklistView`, `BudgetView` and `RegistryView` are still on arrow buttons.
   * `createSortableList` documents and tests all five; see its docblock.
   *
   * Haptics stay here. They are the portal's vocabulary, not the package's, so
   * the package reports phases and this decides what they feel like.
   */
  const reorder = createSortableList({
    ids: eventKeys,
    labelFor: nameForKey,
    noun: "event",
    onMove: (from, to) => store.reorderEvents(from, to),
    onPhase: (phase) => haptic(phase),
  });

  const changesUrl = (op: string) =>
    apiUrl(`/api/organiser/weddings/${props.weddingId}/changes/${op}`);

  /** Load events + guests through the shared caches, then seed the draft. Guests
   *  are loaded even though this tab only edits events: the draft-save posts the
   *  WHOLE DesiredState, so an unloaded guest slice would read as "delete every
   *  household". */
  async function loadInto() {
    const [events, guests, households] = await Promise.all([
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
      // Households ride along for the same reason the guests do, one level down:
      // the guest rows can't describe a household that holds no guests, so
      // without this read a guest-less household is absent from the DesiredState
      // and a schedule-only save deletes it (and its live claim code).
      ensureHouseholdsLoaded(props.weddingId, async () => {
        const res = await authFetch(
          apiUrl(`/api/organiser/weddings/${props.weddingId}/households`),
        );
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("unauthenticated");
        }
        if (!res.ok) throw new Error("Failed to load households");
        return (await res.json()) as OrganiserHouseholdRow[];
      }).then(() => householdsAccessor(props.weddingId)() ?? []),
    ]);
    store.load(events, guests, households);
  }

  onMount(async () => {
    // Same two-layer guard as the guests editor + invite builder: SPA navigation
    // asks before switching away, the browser asks on close/reload.
    onCleanup(registerUnsavedGuard(() => store.dirty()));
    try {
      await loadInto();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setLoadError("Could not load the schedule. Is the API running?");
    }
  });

  // The second layer the comment above promises, and it is not decoration here:
  // a deleted event cascades to its attendance links and RSVPs, so losing an
  // unsaved schedule draft to a tab close is the same silent loss the guest
  // editor's guard exists to prevent. Registered ONLY while dirty — a
  // permanently-attached listener makes the page bfcache-ineligible in
  // Firefox/Safari even with a clean draft.
  createEffect(() => {
    if (!store.dirty()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));
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
    // The row is gone from the draft the moment this returns — the buzz confirms
    // the confirm dialog's answer took, before the save that makes it permanent.
    haptic("commit");
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
      haptic("reject");
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
        body: JSON.stringify({ changeId: p.changeId }),
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
      invalidateHouseholds(props.weddingId);
      setPreview(null);
      setEditingKey(null);
      await loadInto();
      store.commit();
      haptic("commit");
      toast.success("Schedule saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
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
            <Button variant="outline" size="sm" onClick={handleAdd}>
              Add event
            </Button>
          </Show>
        }
      />

      <Show when={loadError()}>
        <Notice tone="error" alert>
          {loadError()}
        </Notice>
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
            <EmptyState
              title="No events yet"
              description="Add an event to start building your schedule. Guests are matched to events that exist."
              action={
                <Button variant="outline" size="sm" onClick={handleAdd}>
                  Add event
                </Button>
              }
            />
          }
        >
          {/* `DragDropSensors` registers the pointer sensor; the keyboard and
              screen-reader paths come from `createSortableList` above.
              `closestCenter` is the right detector for a single-column list. */}
          <DragDropProvider {...reorder.dragHandlers} collisionDetector={closestCenter}>
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
                      sortableItem={reorder.item(event.key, index, () => store.draft.events.length)}
                    />
                  )}
                </For>
              </SortableProvider>
            </ul>
          </DragDropProvider>

          {/* Keyboard instructions, referenced by every grip's aria-describedby —
              the drag affordance is invisible to a screen-reader user otherwise.
              The id is generated per list, so several sortable lists can share a
              page without every grip describing itself with whichever won. */}
          <p {...reorder.hintProps()}>{reorder.hintText}</p>
          {/* Screen-reader feedback for a completed move (drag or keyboard). */}
          <p {...reorder.liveRegionProps()}>{reorder.announcement()}</p>
        </Show>
      </Show>

      {/* Drawer form for the event being edited/added. */}
      <Show when={editingEvent()}>
        {(evt) => (
          <EventDrawer
            event={evt()}
            errors={errorsByKey().get(evt().key) ?? []}
            onPatch={(patch) => store.updateEvent(evt().key, patch)}
            onClose={() => {
              haptic("dismiss");
              setEditingKey(null);
            }}
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
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    store.undo();
                    reorder.clearAnnouncement();
                  }}
                  disabled={!store.canUndo() || busy()}
                >
                  Undo
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    store.discard();
                    reorder.clearAnnouncement();
                    setEditingKey(null);
                  }}
                  disabled={busy()}
                >
                  Discard changes
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={busy() || hasErrors()}
                >
                  {busy() ? "Working…" : "Save changes"}
                </Button>
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
  /** The row's slice of `createSortableList` — grip, move controls, labels. */
  sortableItem: SortableItem;
}) {
  const sortable = createSortable(props.event.key);
  // Non-null: the row only ever renders inside the list's DragDropProvider.
  const [dndState] = useDragDropContext()!;

  /** One screen-reader move control. Activated with Enter/Space (or an AT's
   *  "activate" command), so it works from browse mode where the grip's arrow
   *  keys don't reach. `moveProps` disables it at the list ends rather than
   *  silently no-opping, so AT reports the boundary instead of the user
   *  pressing into nothing. */
  const moveButton = (delta: -1 | 1) => (
    <button
      {...props.sortableItem.moveProps(delta)}
      class="border-border bg-surface font-body text-text-muted hover:text-gold sr-only rounded-sm border px-2 py-1 text-[0.7rem] tracking-[0.1em] uppercase focus:not-sr-only focus:relative focus:z-20"
    >
      {props.sortableItem.moveLabel(delta)}
    </button>
  );

  return (
    <li
      ref={sortable.ref}
      // `ref` registers the node WITHOUT applying the drag transform, which is
      // what lets the grip — rather than the whole row — be the drag affordance.
      // So apply it here. `transform` is an accessor: CALL it, or
      // `maybeTransformStyle` sees a truthy function and paints
      // `translate3d(undefinedpx, …)`.
      style={maybeTransformStyle(sortable.transform())}
      class="border-border bg-surface/30 flex flex-wrap items-center gap-3 rounded-sm border p-4"
      classList={{
        "border-error/50": props.hasError,
        // Lift the row being dragged clear of its neighbours.
        "border-gold/60 bg-surface/80 z-10 shadow-lg": sortable.isActiveDraggable(),
        // Animate the OTHER rows shifting aside, but never the dragged one —
        // that must track the pointer without easing. Only while a drag is live,
        // so the post-drop settle isn't double-animated.
        "transition-transform": !!dndState.active().draggable && !sortable.isActiveDraggable(),
      }}
    >
      {/* Re-order controls: a grip you drag, plus two activate-to-move buttons
          that are only rendered for assistive tech. See `moveButton` above for
          why the second path is NOT redundant. `touch-none` on the grip is
          required — without it the browser scrolls instead of handing the
          gesture to the sensor. */}
      <div class="flex items-center">
        <button
          // `dragActivators` FIRST, so the pointer sensor can never clobber the
          // grip's own keyboard handler — later props win in Solid's spread,
          // and `gripProps` is what carries `onKeyDown`, the label and the ref.
          {...sortable.dragActivators}
          {...props.sortableItem.gripProps()}
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
        {/* The stored value is never printed raw: it carries a derived UTC
            offset, and showing that next to the zone named right after it says
            the same fact twice — once in a form the organiser can't edit. */}
        <p class="font-body text-text-muted truncate text-[0.8rem]">
          <Show when={props.event.startAt} fallback="No start time set">
            {formatEventWhen(props.event.startAt, props.event.endAt, props.event.timezone)}
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
        <Button variant="outline" size="sm" onClick={props.onEdit}>
          Edit
        </Button>
        <Button variant="quiet" size="sm" onClick={props.onDelete}>
          Delete
        </Button>
      </div>
    </li>
  );
}

/** The palette group's heading. Not a `Field` label: the group holds a list of
 *  swatch rows rather than one control, so there is nothing for a `for` to point
 *  at. Kept in step with `Field`'s own label by hand. */
const fieldLabel = "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase";

/** The add/edit drawer — a right-hand panel with the full event form. Every
 *  field writes straight through to the draft (no local staging), so undo/
 *  discard on the sticky bar reach these edits too. */
function EventDrawer(props: {
  event: DraftEvent;
  errors: string[];
  onPatch: (patch: Parameters<ReturnType<typeof createGuestEventDraft>["updateEvent"]>[1]) => void;
  onClose: () => void;
}) {
  // Memos, not plain accessors: the drawer reads each of these from several
  // places per render (the picker, the time input, `stamped`, the hint), and a
  // plain accessor re-runs `splitIso`'s regex on every one of them (P-I1).
  const start = createMemo(() => splitIso(props.event.startAt));
  const end = createMemo(() => splitIso(props.event.endAt));

  /** Stamp the offset the event's ZONE is on for this wall-clock date + time.
   *  The organiser never types an offset any more — it is a fact about the zone
   *  on that day, so it's derived (DST and all). Falls back to whatever offset
   *  the stored value already carried when the zone can't be resolved (an
   *  imported free-text zone this browser's tz database doesn't know), so an
   *  edit elsewhere in the drawer can't silently rewrite an imported time. */
  const stamped = (parts: DateTimeParts, zone: string): DateTimeParts => ({
    ...parts,
    offset: zoneOffset(zone, parts.date, parts.time) ?? parts.offset,
  });

  const setStart = (part: "date" | "time", value: string | null) => {
    const next = { ...start(), [part]: value ?? "" };
    props.onPatch({ startAt: joinIso(stamped(next, props.event.timezone)) });
  };
  const setEnd = (part: "date" | "time", value: string | null) => {
    // An end with a cleared date collapses to "" (open-ended), which the
    // validator + parser accept as "no stated end".
    const next = { ...end(), [part]: value ?? "" };
    props.onPatch({ endAt: joinIso(stamped(next, props.event.timezone)) });
  };

  /** Changing the zone re-stamps BOTH timestamps in ONE patch — one undo step,
   *  and no window in which Start is in the new zone and End still in the old. */
  const setTimezone = (zone: string) => {
    props.onPatch({
      timezone: zone,
      startAt: joinIso(stamped(start(), zone)),
      endAt: joinIso(stamped(end(), zone)),
    });
  };

  /** The zone spelled out with the abbreviation it is on for this event's own
   *  start date — "Australia/Sydney (AEDT)", the thing an organiser recognises.
   *  Deliberately NO UTC offset: the times either side of this field are already
   *  the local ones, so the offset adds no information an organiser can act on,
   *  and printing it invites the "is that the number I'm meant to set?" question
   *  that removing the offset picker was supposed to answer. A zone this runtime
   *  can't resolve (an imported free-text value) gets the bare name.
   *
   *  Memoised because `Field` reads `props.hint` from four places — the
   *  `aria-describedby` id, the spread getter, the `<Show>` gate and the text
   *  insert — and each read would otherwise redo an `Intl` lookup (P-I1). */
  const zoneHint = createMemo(() => {
    const zone = props.event.timezone.trim();
    if (zone.length === 0) return "Pick the zone the event's times are in.";
    return `Times below are local to ${describeTimeZone(zone, start().date || null)}.`;
  });

  /** The dropdown's option groups. Memoised so the ~900-node option list is not
   *  rebuilt on every zone change (P-W1) — `timeZoneGroups` returns a stable
   *  identity for a known zone, and this stops the `each` expression re-running
   *  for one anyway. */
  const zoneGroups = createMemo(() => timeZoneGroups(props.event.timezone));

  /** A blank zone matches no option, and a `<select>` whose value matches none
   *  displays the FIRST one — so a legacy row with `timezone: ""` would read as
   *  "Africa/Abidjan" while the draft still held "", with the free-text escape
   *  hatch now gone. An explicit empty option keeps the field honestly empty and
   *  lets `validateDraft`'s "Timezone is required" mean what it says. */
  const zoneUnset = () => props.event.timezone.trim().length === 0;

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
            <Notice tone="error" alert class="mb-5">
              <For each={props.errors}>{(msg) => <p>{msg}</p>}</For>
            </Notice>
          </Show>

          <div class="flex flex-col gap-5">
            <Field label="Event name">
              {(field) => (
                <Input
                  {...field}
                  value={props.event.name}
                  onInput={(e) => props.onPatch({ name: e.currentTarget.value })}
                />
              )}
            </Field>

            {/* Timezone FIRST — it governs both the Start and the End below, and
                it is the one field a new event arrives with already answered
                (the organiser's own zone). The UTC offset each timestamp carries
                is derived from this, never typed: an offset is a fact about a
                zone on a particular date, so asking for it separately only
                created a way for the two to disagree. */}
            <Field label="Timezone" hint={zoneHint()}>
              {(field) => (
                <Select
                  {...field}
                  value={props.event.timezone}
                  onChange={(e) => setTimezone(e.currentTarget.value)}
                >
                  <Show when={zoneUnset()}>
                    <option value="">Select a timezone…</option>
                  </Show>
                  <For each={zoneGroups()}>
                    {(group) => (
                      <optgroup label={group.label}>
                        <For each={group.zones}>
                          {(zone) => <option value={zone}>{zone}</option>}
                        </For>
                      </optgroup>
                    )}
                  </For>
                </Select>
              )}
            </Field>

            {/* Start: date + time, in the zone above. */}
            <Fieldset legend="Start">
              <DatePicker
                label="Start date"
                value={start().date || null}
                onChange={(v) => setStart("date", v)}
              />
              <div class="flex flex-wrap items-end gap-3">
                {/* The visible label is "Time" — the legend above says which time.
                    An `aria-label` names it in full anyway: a legend is only
                    reliably announced for a radio group, and "Time" on its own is
                    the same word as the end field's. Keeping the visible text
                    inside the spoken name is what WCAG 2.5.3 asks for. */}
                <Field label="Time">
                  {(field) => (
                    <Input
                      {...field}
                      type="time"
                      value={start().time}
                      aria-label="Start time"
                      onInput={(e) => setStart("time", e.currentTarget.value)}
                    />
                  )}
                </Field>
              </div>
            </Fieldset>

            {/* End (optional). */}
            <Fieldset legend="End (optional)">
              <DatePicker
                label="End date"
                value={end().date || null}
                onChange={(v) => setEnd("date", v)}
              />
              <div class="flex flex-wrap items-end gap-3">
                <Field label="Time">
                  {(field) => (
                    <Input
                      {...field}
                      type="time"
                      value={end().time}
                      aria-label="End time"
                      onInput={(e) => setEnd("time", e.currentTarget.value)}
                    />
                  )}
                </Field>
              </div>
            </Fieldset>

            <Field label="Address">
              {(field) => (
                <Input
                  {...field}
                  value={props.event.address ?? ""}
                  onInput={(e) =>
                    props.onPatch({
                      address: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                    })
                  }
                />
              )}
            </Field>

            <Field label="Dress code description">
              {(field) => (
                <Textarea
                  {...field}
                  value={props.event.dressCodeDescription ?? ""}
                  rows={2}
                  onInput={(e) =>
                    props.onPatch({
                      dressCodeDescription:
                        e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                    })
                  }
                />
              )}
            </Field>

            {/* Dress-code palette — each swatch a name + a ColorPicker. */}
            <div class="flex flex-col gap-2">
              <span class={fieldLabel}>Dress code palette</span>
              <For each={props.event.dressCodePalette}>
                {(swatch, i) => (
                  <div class="flex flex-wrap items-end gap-2">
                    <Field labelHidden label={`Swatch ${i() + 1} name`} class="flex-1">
                      {(field) => (
                        <Input
                          {...field}
                          value={swatch.name}
                          placeholder="Blush"
                          onInput={(e) => updateSwatch(i(), { name: e.currentTarget.value })}
                        />
                      )}
                    </Field>
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
              <Button variant="outline" size="sm" onClick={addSwatch} class="self-start">
                Add swatch
              </Button>
            </div>

            <Field label="Pinterest URL">
              {(field) => (
                <Input
                  {...field}
                  type="url"
                  value={props.event.pinterestUrl ?? ""}
                  placeholder="https://www.pinterest.com/…"
                  onInput={(e) =>
                    props.onPatch({
                      pinterestUrl: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                    })
                  }
                />
              )}
            </Field>

            <Field label="Maps URL">
              {(field) => (
                <Input
                  {...field}
                  type="url"
                  value={props.event.mapsUrl ?? ""}
                  placeholder="https://maps.google.com/…"
                  onInput={(e) =>
                    props.onPatch({
                      mapsUrl: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
                    })
                  }
                />
              )}
            </Field>

            <Button variant="primary" onClick={props.onClose} class="mt-2 self-start">
              Done
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
