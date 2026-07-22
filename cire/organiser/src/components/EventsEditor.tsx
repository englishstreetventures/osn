import { useAuth } from "@osn/client/solid";
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

/**
 * The Events EDITOR (guest+event editor E6, §8). A re-orderable list of events
 * on top of the SHARED draft store (the same one the Guests editor uses — E6
 * mutates the `events` slice E5 carried through untouched). Add/edit an event
 * via a drawer form (name, start/end + timezone, address, dress-code + palette
 * reusing {@link ColorPicker}, Pinterest/Maps URLs); delete with an impact
 * confirm; re-order (writes `sortOrder`). Save posts the WHOLE draft (events +
 * families) as DesiredState JSON to `changes/preview` → the shared
 * {@link ChangePreview} modal → `changes/apply` on confirm → refetch + toast.
 *
 * Field-invalid drafts can't be submitted — Save disables and the drawer shows
 * errors inline. Guests ride along unchanged (id-matched ⇒ no-op update).
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
        description="Add and re-order the events your guests can be invited to, set the details, and save. Every change is previewed before it's applied — you'll see exactly what will change, including anything that affects RSVPs or images."
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
          <ul class="flex flex-col gap-3">
            <For each={store.draft.events}>
              {(event, index) => (
                <EventRowCard
                  event={event}
                  index={index()}
                  count={store.draft.events.length}
                  hasError={(errorsByKey().get(event.key)?.length ?? 0) > 0}
                  onEdit={() => setEditingKey(event.key)}
                  onDelete={() => handleDelete(event)}
                  onMoveUp={() => store.moveEvent(event.key, -1)}
                  onMoveDown={() => store.moveEvent(event.key, 1)}
                />
              )}
            </For>
          </ul>
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
            <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
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
                  onClick={store.undo}
                  disabled={!store.canUndo() || busy()}
                  class="font-body text-text-muted hover:text-gold border-border rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    store.discard();
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
              <p class="border-gold/20 bg-gold/5 text-gold-dim mx-auto max-w-5xl border-t px-4 py-2 text-[0.82rem]">
                {store.warnings().join(" ")}
              </p>
            </Show>
            <Show when={saveError()}>
              <p class="border-error/20 bg-error/5 text-error mx-auto max-w-5xl border-t px-4 py-2 text-[0.82rem]">
                {saveError()}
              </p>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

/** One event summary row with re-order + edit/delete controls. */
function EventRowCard(props: {
  event: DraftEvent;
  index: number;
  count: number;
  hasError: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <li
      class="border-border bg-surface/30 flex flex-wrap items-center gap-3 rounded-sm border p-4"
      classList={{ "border-error/50": props.hasError }}
    >
      <div class="flex flex-col">
        <button
          type="button"
          aria-label={`Move ${props.event.name || "event"} up`}
          disabled={props.index === 0}
          onClick={props.onMoveUp}
          class="text-text-muted hover:text-gold disabled:opacity-30"
        >
          ▲
        </button>
        <button
          type="button"
          aria-label={`Move ${props.event.name || "event"} down`}
          disabled={props.index === props.count - 1}
          onClick={props.onMoveDown}
          class="text-text-muted hover:text-gold disabled:opacity-30"
        >
          ▼
        </button>
      </div>

      <div class="min-w-0 flex-1">
        <p class="font-display text-text truncate text-[1.15rem]">
          {props.event.name || <span class="text-text-muted not-italic">Untitled event</span>}
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
