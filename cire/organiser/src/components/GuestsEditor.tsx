import { useAuth } from "@osn/client/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
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
import ChangePreview, { type ChangePlan } from "./ChangePreview";
import SectionIntro from "./SectionIntro";

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

  /** Load events + guests through the shared caches, then seed the draft. */
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
      setLoadError("Could not load the guest list. Is the API running?");
    }
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
          throw new Error("The guest list changed elsewhere. Re-open Save to preview afresh.");
        }
        throw new Error(body.error ?? `Apply failed (${res.status})`);
      }
      // The roster changed — drop the caches, refetch, and re-seed the draft so
      // the editor reflects server-assigned ids (new households/guests) and the
      // baseline resets (dirty ⇒ false).
      invalidateGuests(props.weddingId);
      invalidateEvents(props.weddingId);
      setPreview(null);
      await loadInto();
      store.commit();
      toast.success("Guest list saved");
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
        eyebrow="Guest list"
        title="Edit households & guests"
        description="Add households and guests, set who's invited to each event, and save. Every change is previewed before it's applied — you'll see exactly what will change."
        actions={
          <Show when={store.loaded()}>
            <button
              type="button"
              onClick={store.addFamily}
              class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition"
            >
              Add household
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
            {() => <div class="bg-surface h-[80px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={store.loaded()}>
        <Show
          when={store.draft.families.length > 0}
          fallback={
            <div class="border-border bg-surface/30 flex flex-col items-start gap-2 rounded-sm border border-dashed p-8 text-center">
              <p class="font-display text-gold-dim w-full text-[1.2rem] italic">
                No households yet
              </p>
              <p class="font-body text-text-muted w-full text-[0.85rem]">
                Add a household to start building your guest list.
              </p>
            </div>
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
        )}
      </Show>

      {/* Sticky unsaved-changes bar (§8) — only while dirty. */}
      <Show when={store.loaded() && store.dirty()}>
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
                onClick={store.discard}
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
          <Show when={saveError()}>
            <p class="border-error/20 bg-error/5 text-error mx-auto max-w-5xl border-t px-4 py-2 text-[0.82rem]">
              {saveError()}
            </p>
          </Show>
        </div>
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
            class="border-border bg-bg font-display text-text focus:border-gold rounded-sm border px-3 py-1.5 text-[1.05rem] italic outline-none"
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
          <button
            type="button"
            onClick={() => props.store.removeFamily(props.family.key)}
            class="font-body text-text-muted hover:text-error hover:border-error/60 border-border rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.1em] uppercase transition-colors"
            title="Delete this household. Its claim code is disabled and any RSVPs are discarded — you'll confirm the impact before it's applied."
          >
            Delete household
          </button>
        </div>
      </div>

      <For each={famErrors()}>{(msg) => <p class="text-error text-[0.78rem]">{msg}</p>}</For>

      <div class="overflow-x-auto">
        <table class="font-body w-full border-collapse text-[0.85rem]">
          <thead>
            <tr>
              <th class="border-border text-gold border-b px-2 py-2 text-left text-[0.66rem] font-normal tracking-[0.1em] uppercase">
                First name
              </th>
              <th class="border-border text-gold border-b px-2 py-2 text-left text-[0.66rem] font-normal tracking-[0.1em] uppercase">
                Last name
              </th>
              <th class="border-border text-gold border-b px-2 py-2 text-left text-[0.66rem] font-normal tracking-[0.1em] uppercase">
                Nickname
              </th>
              <For each={props.events}>
                {(evt) => (
                  <th class="border-border text-gold border-b px-2 py-2 text-center text-[0.66rem] font-normal tracking-[0.1em] uppercase">
                    {evt.name || "Untitled event"}
                  </th>
                )}
              </For>
              <th class="border-border border-b px-2 py-2">
                <span class="sr-only">Actions</span>
              </th>
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
        </table>
      </div>

      <button
        type="button"
        onClick={() => props.store.addGuest(props.family.key)}
        class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 self-start rounded-sm border px-3 py-1.5 text-[0.7rem] tracking-[0.1em] uppercase transition"
      >
        Add guest
      </button>
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
        <td class="border-border border-b px-2 py-2">
          <input
            type="text"
            value={props.guest.firstName}
            aria-label="First name"
            aria-invalid={props.errors.length > 0}
            onInput={(e) =>
              props.store.updateGuest(props.guest.key, { firstName: e.currentTarget.value })
            }
            class="border-border bg-bg text-text focus:border-gold w-full rounded-sm border px-2 py-1 outline-none"
          />
        </td>
        <td class="border-border border-b px-2 py-2">
          <input
            type="text"
            value={props.guest.lastName}
            aria-label="Last name"
            onInput={(e) =>
              props.store.updateGuest(props.guest.key, { lastName: e.currentTarget.value })
            }
            class="border-border bg-bg text-text focus:border-gold w-full rounded-sm border px-2 py-1 outline-none"
          />
        </td>
        <td class="border-border border-b px-2 py-2">
          <input
            type="text"
            value={props.guest.nickname ?? ""}
            aria-label="Nickname"
            placeholder="—"
            onInput={(e) =>
              props.store.updateGuest(props.guest.key, {
                nickname: e.currentTarget.value.length > 0 ? e.currentTarget.value : null,
              })
            }
            class="border-border bg-bg text-text-muted focus:border-gold w-full rounded-sm border px-2 py-1 outline-none"
          />
        </td>
        <For each={props.events}>
          {(evt) => (
            <td class="border-border border-b px-2 py-2 text-center">
              <input
                type="checkbox"
                checked={props.guest.eventKeys.includes(evt.key)}
                aria-label={`${props.guest.firstName || "Guest"} attends ${evt.name || "event"}`}
                onChange={() => props.store.toggleAttendance(props.guest.key, evt.key)}
                class="accent-gold h-4 w-4 cursor-pointer"
              />
            </td>
          )}
        </For>
        <td class="border-border border-b px-2 py-2 text-right">
          <button
            type="button"
            onClick={() => props.store.removeGuest(props.guest.key)}
            aria-label={`Remove ${props.guest.firstName || "guest"}`}
            class="font-body text-text-muted hover:text-error text-[0.72rem] tracking-[0.1em] uppercase transition-colors"
          >
            Remove
          </button>
        </td>
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
