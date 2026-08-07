import { useAuth } from "@shared/rp-auth/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  invalidateEvents,
} from "../lib/events-store";
import { createGuestEventDraft, type DraftFamily, type DraftGuest } from "../lib/guest-event-draft";
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
import { registerUnsavedGuard } from "../lib/unsaved-guard";
import ChangePreview, { type ChangePlan } from "./ChangePreview";
import SectionIntro from "./SectionIntro";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import { Input } from "./ui/Field";
import Notice from "./ui/Notice";
import { Table, Td, Th } from "./ui/Table";

interface PreviewResponse {
  changeId: string;
  plan: ChangePlan;
  warnings: string[];
  baseRevision: string;
}

/**
 * The Guests EDITOR (guest+event editor E5, §8). A household-grouped, inline-
 * editable list on top of the shared draft store: add/rename/delete households
 * and guests (id-preserving so a rename is an UPDATE, not remove+create), edit
 * nickname, and tick a per-guest × per-event attendance matrix. All edits are
 * local (no server round-trips while editing — the store gives in-session undo +
 * discard for free); Save posts the whole draft as DesiredState JSON to
 * `changes/preview`, shows the shared {@link ChangePreview} (diff + confirm-gated
 * impact warnings), then `changes/apply` on confirm, refetches, and toasts.
 *
 * Field-invalid drafts can't be submitted — the Save button disables and errors
 * render inline next to the offending row.
 */
export default function GuestsEditor(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  const store = createGuestEventDraft();

  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<PreviewResponse | null>(null);

  const changesUrl = (op: string) =>
    apiUrl(`/api/organiser/weddings/${props.weddingId}/changes/${op}`);

  /** Load events + guests + households through the shared caches, then seed the
   *  draft. Households are read separately because the guest rows only describe
   *  households that HOLD a guest — see `buildDraft`. */
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
    // A dirty draft is guarded twice: the dashboard's SPA navigation asks before
    // switching module/tab (unsaved-guard), and the browser asks on tab close /
    // reload. Without this, every unsaved edit — including a deletion — was
    // dropped silently by a stray sidebar click, which reads exactly like "the
    // guest I deleted came back".
    onCleanup(registerUnsavedGuard(() => store.dirty()));
    try {
      await loadInto();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setLoadError("Could not load the guest list. Is the API running?");
    }
  });

  // The beforeunload listener exists ONLY while dirty — a persistently
  // registered one makes the page ineligible for the back/forward cache in
  // Firefox/Safari even with a clean draft (same rule as the invite builder).
  createEffect(() => {
    if (!store.dirty()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));
  });

  // The draft's event list drives the attendance-matrix columns.
  const eventColumns = () => store.draft.events;

  /** Field errors indexed by the offending row's draft key, for inline display. */
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
        body: JSON.stringify({ changeId: p.changeId, importId: p.changeId }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // 409 = a co-host applied in between; the previewed diff is stale, so
        // the modal is dismissed — re-confirming it could only 409 again, and
        // the error itself renders in the sticky bar the modal was covering.
        if (res.status === 409) {
          setPreview(null);
          throw new Error("The guest list changed elsewhere. Re-open Save to preview afresh.");
        }
        throw new Error(body.error ?? `Apply failed (${res.status})`);
      }
      // The roster changed — drop the caches, refetch, and re-seed the draft so
      // the editor reflects server-assigned ids (new households/guests) and the
      // baseline resets (dirty ⇒ false).
      invalidateGuests(props.weddingId);
      invalidateEvents(props.weddingId);
      invalidateHouseholds(props.weddingId);
      setPreview(null);
      await loadInto();
      store.commit();
      haptic("commit");
      toast.success("Guest list saved");
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
        eyebrow="Guest list"
        title="Edit households & guests"
        description="Add households and guests, set who's invited to each event, and save. Every change is previewed before it's applied — you'll see exactly what will change."
        actions={
          <Show when={store.loaded()}>
            <Button variant="outline" size="sm" onClick={store.addFamily}>
              Add household
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
            {() => <div class="bg-surface h-[80px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={store.loaded()}>
        <Show
          when={store.draft.families.length > 0}
          fallback={
            <EmptyState
              title="No households yet"
              description="Add a household to start building your guest list."
              action={
                <Button variant="outline" size="sm" onClick={store.addFamily}>
                  Add household
                </Button>
              }
            />
          }
        >
          <div class="flex flex-col gap-6">
            <For each={store.draft.families}>
              {(family) => (
                <FamilyCard
                  family={family}
                  events={eventColumns()}
                  errorsByKey={errorsByKey()}
                  store={store}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Preview modal (the shared ChangePreview) — shown after a successful
          preview, gates the apply. */}
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
                {/* An apply error has to render HERE as well as in the sticky
                    bar: the bar sits behind this modal's overlay, so a failed
                    apply otherwise looked like nothing happened at all. */}
                <Show when={saveError()}>
                  <Notice tone="error" alert class="mt-4">
                    {saveError()}
                  </Notice>
                </Show>
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
                    haptic("step");
                    store.undo();
                  }}
                  disabled={!store.canUndo() || busy()}
                >
                  Undo
                </Button>
                {/* Danger, where the card's "Delete household" is quiet: this
                    one throws away every unsaved edit at once and there is no
                    preview between the click and the loss. */}
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    haptic("dismiss");
                    store.discard();
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
            {/* The bar's own error, in its own box rather than a full-bleed
                strip: the strip shared the bar's background and read as part of
                the chrome instead of as something that just failed. */}
            <Show when={saveError()}>
              <div class="page-frame pb-3">
                <Notice tone="error" alert>
                  {saveError()}
                </Notice>
              </div>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

/** One editable household card: name field + delete, then its guests as rows in
 *  a per-guest × per-event attendance matrix, plus an "Add guest" action. */
function FamilyCard(props: {
  family: DraftFamily;
  events: { key: string; name: string }[];
  errorsByKey: Map<string, string[]>;
  store: ReturnType<typeof createGuestEventDraft>;
}) {
  const famErrors = () => props.errorsByKey.get(props.family.key) ?? [];
  return (
    <div class="border-border bg-surface/30 flex flex-col gap-4 rounded-sm border p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <label class="flex flex-1 flex-col gap-1">
          <span class="font-body text-text-muted text-[0.66rem] tracking-[0.14em] uppercase">
            Household name
          </span>
          <input
            type="text"
            value={props.family.familyName}
            aria-label="Household name"
            aria-invalid={famErrors().length > 0}
            onInput={(e) => props.store.renameFamily(props.family.key, e.currentTarget.value)}
            class="border-border bg-bg font-display text-text focus:border-gold rounded-sm border px-3 py-1.5 text-[1.05rem] outline-none"
          />
        </label>
        <div class="flex items-center gap-3">
          <Show
            when={props.family.publicId}
            fallback={
              <span class="font-body text-gold/70 border-gold/30 rounded-sm border px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase not-italic">
                New — code minted on save
              </span>
            }
          >
            <span
              class="text-text-muted font-mono text-[0.72rem]"
              title="This household's claim code — deleting the household disables it."
            >
              {props.family.publicId}
            </span>
          </Show>
          {/* Quiet, not danger: nothing is destroyed on this click. It marks the
              household for removal, and `ChangePreview` spells out the cost
              before anything is applied. A red button per card would shout
              louder than what the button does. */}
          <Button
            variant="quiet"
            size="sm"
            onClick={() => props.store.removeFamily(props.family.key)}
            title="Delete this household. Its claim code is disabled and any RSVPs are discarded — you'll confirm the impact before it's applied."
          >
            Delete household
          </Button>
        </div>
      </div>

      <For each={famErrors()}>{(msg) => <p class="text-error text-[0.78rem]">{msg}</p>}</For>

      {/* The shared `Table`, which also makes the sideways scroll reachable from
          a keyboard — the bare `overflow-x-auto` div it replaces could only be
          scrolled with a pointer, and this is the one table in the portal that
          grows a column per event. */}
      <Table label={`Guests in ${props.family.familyName || "this household"}`}>
        <thead>
          <tr>
            <Th>First name</Th>
            <Th>Last name</Th>
            <Th>Nickname</Th>
            <For each={props.events}>
              {(evt) => <Th align="center">{evt.name || "Untitled event"}</Th>}
            </For>
            <Th>
              <span class="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          <For each={props.family.guests}>
            {(guest) => (
              <GuestRow
                guest={guest}
                events={props.events}
                errors={props.errorsByKey.get(guest.key) ?? []}
                store={props.store}
              />
            )}
          </For>
        </tbody>
      </Table>

      {/* A household CAN legitimately hold no guests — one added but not yet
          filled in, or emptied by an earlier save. It stays in the list (and
          keeps its claim code) until it is deleted on purpose, so say so rather
          than rendering a bare header row. */}
      <Show when={props.family.guests.length === 0}>
        <p class="font-body text-text-muted text-[0.8rem]">
          No guests in this household yet — its invite code won’t show anyone.
        </p>
      </Show>

      <Button
        variant="outline"
        size="sm"
        class="self-start"
        onClick={() => props.store.addGuest(props.family.key)}
      >
        Add guest
      </Button>
    </div>
  );
}

/** One guest row: editable name/nickname fields + an attendance checkbox per
 *  event column + a delete action. */
function GuestRow(props: {
  guest: DraftGuest;
  events: { key: string; name: string }[];
  errors: string[];
  store: ReturnType<typeof createGuestEventDraft>;
}) {
  return (
    <>
      <tr class="hover:[&>td]:bg-surface/50">
        <Td>
          {/* No `Field` around these: the column heading names the control, so a
              visible label per cell would repeat it 200 times down the page.
              `aria-label` carries the name instead. */}
          <Input
            size="sm"
            value={props.guest.firstName}
            aria-label="First name"
            aria-invalid={props.errors.length > 0}
            onInput={(e) =>
              props.store.updateGuest(props.guest.key, { firstName: e.currentTarget.value })
            }
          />
        </Td>
        <Td>
          <Input
            size="sm"
            value={props.guest.lastName}
            aria-label="Last name"
            onInput={(e) =>
              props.store.updateGuest(props.guest.key, { lastName: e.currentTarget.value })
            }
          />
        </Td>
        <Td>
          {/* The muted text colour is gone on purpose: it set `color`, which
              `Input` also sets, and two utilities on one property resolve by
              stylesheet order rather than by class order. The em-dash
              placeholder already says the field is optional. */}
          <Input
            size="sm"
            value={props.guest.nickname ?? ""}
            aria-label="Nickname"
            placeholder="—"
            onInput={(e) =>
              props.store.updateGuest(props.guest.key, {
                nickname: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
              })
            }
          />
        </Td>
        <For each={props.events}>
          {(evt) => (
            <Td class="text-center">
              <input
                type="checkbox"
                checked={props.guest.eventKeys.includes(evt.key)}
                aria-label={`${props.guest.firstName || "Guest"} attends ${evt.name || "event"}`}
                onChange={() => props.store.toggleAttendance(props.guest.key, evt.key)}
                class="accent-gold h-4 w-4 cursor-pointer"
              />
            </Td>
          )}
        </For>
        <Td class="text-right">
          <button
            type="button"
            onClick={() => props.store.removeGuest(props.guest.key)}
            aria-label={`Remove ${props.guest.firstName || "guest"}`}
            class="font-body text-text-muted hover:text-error text-[0.72rem] tracking-[0.1em] uppercase transition-colors"
          >
            Remove
          </button>
        </Td>
      </tr>
      <Show when={props.errors.length > 0}>
        <tr>
          <td colspan={3 + props.events.length + 1} class="px-2 pb-2">
            <For each={props.errors}>{(msg) => <p class="text-error text-[0.76rem]">{msg}</p>}</For>
          </td>
        </tr>
      </Show>
    </>
  );
}
