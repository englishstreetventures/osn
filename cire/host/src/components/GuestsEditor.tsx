import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Input } from "@shared/ui/ui/input";
import { heldWhileClosing, Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import type { SafeProps } from "@shared/ui/ui/props";
import { Table, Td, Th } from "@shared/ui/ui/table";
import Plus from "lucide-solid/icons/plus";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

import { allAuthFirst, apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import {
  isChangeInProgress,
  isHeadMoved,
  isPreviewExpired,
  loadHeadRevision,
  revisionOf,
} from "../lib/change-revision";
import {
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  invalidateEvents,
} from "../lib/events-store";
import {
  createGuestEventDraft,
  type DraftFamily,
  type DraftGuest,
  EMAIL_ERROR,
} from "../lib/guest-event-draft";
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
import { IconButton } from "./ActionTip";
import ChangePreview, {
  type ApplyChangeBody,
  type ChangeChoice,
  type ChangePlan,
  type ClearedHalves,
} from "./ChangePreview";
import SectionIntro from "./SectionIntro";
import { createCompact, holdUntilReady, ViewBar } from "./ViewBar";

/** Below this panel width the bar's controls show their icons alone, and a
 *  card's stuck header holds the household's name and nothing else. The same
 *  line as the shell's sub-tabs (`ModuleShell.tsx`). */
const NARROW_BAR_REM = 36;

/** The editor table's fixed columns, in rem: names, nickname, email, one per
 *  event, then the remove button. Shared by each card's table and its head
 *  strip, so the two line up. */
const COLUMNS = { first: 9, last: 9, nickname: 8, email: 14, event: 8, actions: 6.5 } as const;

const tableWidth = (events: number) =>
  `max(100%, ${
    COLUMNS.first +
    COLUMNS.last +
    COLUMNS.nickname +
    COLUMNS.email +
    COLUMNS.actions +
    COLUMNS.event * events
  }rem)`;

/** Where a focused field in a card's rows must stay below: the top bar, the
 *  view bar, and the card's stuck header and head strip. */
const ROWS_SCROLL_MARGIN =
  "[&_:is(button,input,a)]:scroll-mt-[calc(var(--chrome-h)+var(--bar-h,0px)+var(--card-head-h)+var(--head-strip-h)+0.5rem)]";
interface PreviewResponse {
  changeId: string;
  plan: ChangePlan;
  warnings: string[];
  baseRevision: string;
  /** Set when the save removes every household; apply echoes it back. */
  clears: ClearedHalves | null;
  /** How many guest addresses the save sets on the organiser's word. Absent
   *  from an API older than addresses. */
  emailAttestations?: number;
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
export default function GuestsEditor(props: {
  weddingId: string;
  /** Drawn alone, outside the module shell: whether to draw the narrow bar
   *  and card headers. Inside the shell the panel's width decides. */
  compact?: boolean;
}) {
  const { authFetch } = useAuth();
  const store = createGuestEventDraft();
  const { compact } = createCompact(
    () => NARROW_BAR_REM,
    () => props.compact ?? false,
  );
  const ready = holdUntilReady();
  createEffect(() => {
    if (store.loaded() || loadError()) ready();
  });

  // Each card's name field, by household key, so Add household can hand focus
  // to the card it just added — which may be a long way down the page.
  const nameFields = new Map<string, HTMLInputElement>();
  function addHousehold() {
    const key = store.addFamily();
    nameFields.get(key)?.focus();
  }

  // Each card's head strip follows its table's sideways scroll. One listener
  // for the whole editor, in the capture phase because `scroll` does not
  // bubble; it finds the strip from the box that scrolled.
  onMount(() => {
    const follow = (event: Event) => {
      const box = event.target;
      if (!(box instanceof HTMLElement) || !box.matches("[data-edit-card] section")) return;
      const strip = box
        .closest("[data-edit-card]")
        ?.querySelector<HTMLElement>("[data-head-strip]");
      if (strip) strip.scrollLeft = box.scrollLeft;
    };
    document.addEventListener("scroll", follow, { capture: true, passive: true });
    onCleanup(() => document.removeEventListener("scroll", follow, { capture: true }));
  });

  // Which event heads do not fit their column, read from the first card's
  // strip: every strip has the same columns, so one answer serves all. Those
  // heads become buttons that show the whole name.
  const [clipped, setClipped] = createSignal<ReadonlySet<string>>(new Set());
  let firstStrip: HTMLElement | undefined;
  function measureHeads() {
    const strip = document.querySelector<HTMLElement>("[data-edit-card] [data-head-strip]");
    if (!strip) return;
    const next = new Set<string>();
    for (const label of strip.querySelectorAll<HTMLElement>("[data-event-head]")) {
      if (label.scrollWidth > label.clientWidth + 1) next.add(label.dataset.eventHead!);
    }
    const prev = clipped();
    if (next.size !== prev.size || [...next].some((k) => !prev.has(k))) setClipped(next);
    if (strip !== firstStrip) {
      firstStrip = strip;
      headObserver?.disconnect();
      headObserver = new ResizeObserver(measureHeads);
      headObserver.observe(strip);
    }
  }
  let headObserver: ResizeObserver | undefined;
  onCleanup(() => headObserver?.disconnect());
  // The words change width when the face arrives, the columns do not.
  onMount(() => void document.fonts?.ready.then(measureHeads));

  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Set when a save is refused because someone else's change landed after
  // this draft was loaded; offers to reload with the unsaved edits kept.
  const [stale, setStale] = createSignal(false);
  // What the last keep-edits reload could not keep, or wants checked.
  const [replayNotes, setReplayNotes] = createSignal<string[]>([]);
  const [preview, setPreview] = createSignal<PreviewResponse | null>(null);
  const shownPreview = heldWhileClosing(preview);

  const changesUrl = (op: string) => apiUrl(weddingPath(props.weddingId, `/changes/${op}`));

  /** Read the change head, then load events + guests + households and seed the
   *  draft at that head.
   *
   *  The head comes FIRST and the rows after it, fetched fresh: the shared
   *  caches may hold rows loaded long before, and a row a co-host committed in
   *  between would be missing from the draft while the head already counted it
   *  — the save would read it as a removal and the API could not tell. Dropping
   *  the cached rows here makes every row the draft sees at least as new as the
   *  head it sends back.
   *
   *  Households are read separately because the guest rows only describe
   *  households that HOLD a guest — see `buildDraft`. The draft-save posts the
   *  WHOLE DesiredState, so a slice that resolves without filling the cache (a
   *  generation-discarded load, e.g. an invalidate landing mid-fetch) must not
   *  fall back to `?? []` — that reads as "delete everything in this slice".
   *  The `!fresh` checks below throw instead, so the load error is surfaced
   *  rather than seeding an empty draft. */
  async function fetchRows(knownRevision?: string) {
    // After a save, the apply response already names the head its own commit
    // left, and it was read before the rows below are: no second request.
    const revision = knownRevision ?? (await loadHeadRevision(authFetch, props.weddingId));
    invalidateEvents(props.weddingId);
    invalidateGuests(props.weddingId);
    invalidateHouseholds(props.weddingId);
    const [events, guests, households] = await allAuthFirst([
      ensureEventsLoaded(props.weddingId, async () => {
        const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/events")));
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("unauthenticated");
        }
        if (!res.ok) throw new Error("Failed to load events");
        return (await res.json()) as EventRow[];
      }).then((fresh) => {
        const rows = eventsAccessor(props.weddingId)();
        if (!fresh || rows == null) throw new Error("event slice unavailable");
        return rows;
      }),
      ensureGuestsLoaded(props.weddingId, async () => {
        const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/guests")));
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("unauthenticated");
        }
        if (!res.ok) throw new Error("Failed to load guests");
        return (await res.json()) as OrganiserGuestRow[];
      }).then((fresh) => {
        const rows = guestsAccessor(props.weddingId)();
        if (!fresh || rows == null) throw new Error("guest slice unavailable");
        return rows;
      }),
      ensureHouseholdsLoaded(props.weddingId, async () => {
        const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/households")));
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("unauthenticated");
        }
        if (!res.ok) throw new Error("Failed to load households");
        return (await res.json()) as OrganiserHouseholdRow[];
      }).then((fresh) => {
        const rows = householdsAccessor(props.weddingId)();
        if (!fresh || rows == null) throw new Error("household slice unavailable");
        return rows;
      }),
    ]);
    return { revision, events, guests, households };
  }

  async function loadInto(knownRevision?: string) {
    const rows = await fetchRows(knownRevision);
    store.load(rows.events, rows.guests, rows.households, rows.revision);
  }

  /** Reload the rows after someone else's change and put the organiser's
   *  unsaved edits back on top, so the next save is built on the new head. */
  async function handleKeepEdits() {
    setSaveError(null);
    setBusy(true);
    try {
      const rows = await fetchRows();
      setReplayNotes(store.rebase(rows.events, rows.guests, rows.households, rows.revision));
      setStale(false);
      haptic("commit");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setSaveError("Could not reload the guest list. Try again.");
    } finally {
      setBusy(false);
    }
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
        // `scope: "guests"`: this editor never changes the schedule, so its save
        // carries no authority over it — the events ride along only so the
        // attendance columns can name them.
        body: JSON.stringify({
          desiredState: store.toWire("guests"),
          scope: "guests",
          removeManual: true,
          baseRevision: store.baseRevision(),
        }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        if (res.status === 409 && body.reason === "stale_draft") {
          setStale(true);
          throw new Error("Someone else changed the guest list since you opened the editor.");
        }
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

  /** The apply body: the change, the counts a clear needs echoed back, and
   *  the address attestation once ticked. */
  function applyBody(p: PreviewResponse, choice: ChangeChoice): ApplyChangeBody {
    const body: ApplyChangeBody = { changeId: p.changeId };
    if (p.clears) body.confirmClears = p.clears;
    if (choice.emailAttestation !== undefined) body.emailAttestation = choice.emailAttestation;
    return body;
  }

  async function handleApply(choice: ChangeChoice) {
    const p = preview();
    if (!p) return;
    setSaveError(null);
    setBusy(true);
    try {
      const res = await authFetch(changesUrl("apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Removing every household is applied only with the count the preview
        // showed echoed back.
        body: JSON.stringify(applyBody(p, choice)),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        // 409 = a co-host applied in between; the previewed diff is stale, so
        // the modal is dismissed — re-confirming it could only 409 again, and
        // the error itself renders in the sticky bar the modal was covering.
        // Another save still being written, or a preview too old to apply, are
        // the 409s that are not stale: say so, since the same edit will save
        // once that change finishes, or from a fresh preview.
        if (res.status === 409) {
          setPreview(null);
          if (isHeadMoved(body)) {
            setStale(true);
            throw new Error("Someone else changed the guest list since you opened the editor.");
          }
          if (isPreviewExpired(body)) {
            throw new Error(
              "This preview has expired. Press Save changes to preview your edits again.",
            );
          }
          throw new Error(
            isChangeInProgress(body) && body.error
              ? body.error
              : "The guest list changed elsewhere. Re-open Save to preview afresh.",
          );
        }
        throw new Error(body.error ?? `Apply failed (${res.status})`);
      }
      const applied: unknown = await res.json().catch(() => null);
      // The roster changed — drop the caches, refetch, and re-seed the draft so
      // the editor reflects server-assigned ids (new households/guests) and the
      // baseline resets (dirty ⇒ false).
      invalidateGuests(props.weddingId);
      invalidateEvents(props.weddingId);
      invalidateHouseholds(props.weddingId);
      setPreview(null);
      try {
        await loadInto(revisionOf(applied));
        store.commit();
        setStale(false);
        setReplayNotes([]);
      } catch (err) {
        // The save went through, so the draft describes rows the server has
        // since given ids the draft never received: saving it again would post
        // every new household as new a second time, and the server would
        // remove and re-create them under fresh claim codes. So the draft is dropped — before
        // any redirect too, since the tab-close guard would otherwise hold a
        // dirty draft open — and the editor stays shut until it reloads.
        store.reset();
        if (isAuthExpired(err)) return redirectToLogin();
        setLoadError("Saved, but the editor could not reload. Refresh to continue.");
        return;
      }
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
      <SectionIntro eyebrow="Guest list" title="Edit households & guests" />

      {/* Add household, in the view bar beside the mode switch, so it is to
          hand however far down the list the host is. */}
      <Show when={store.loaded()}>
        <ViewBar slot="end">
          <Show
            when={compact()}
            fallback={
              <Button variant="outline" size="sm" class="shrink-0" onClick={addHousehold}>
                <Plus aria-hidden="true" strokeWidth={1.75} class="size-3.5" />
                Add household
              </Button>
            }
          >
            <IconButton variant="outline" size="icon" label="Add household" onClick={addHousehold}>
              <Plus aria-hidden="true" strokeWidth={1.75} class="size-4" />
            </IconButton>
          </Show>
        </ViewBar>
      </Show>

      <Show when={loadError()}>
        <Notice tone="danger" alert>
          {loadError()}
        </Notice>
      </Show>

      <Show when={replayNotes().length > 0}>
        <Notice tone="warn" alert>
          <p>Your edits are back on top of the latest guest list. Check these before saving:</p>
          <ul class="mt-2 list-disc pl-5">
            <For each={replayNotes()}>{(note) => <li>{note}</li>}</For>
          </ul>
        </Notice>
      </Show>

      <Show when={!store.loaded() && !loadError()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3]}>
            {() => <div class="bg-surface h-20 animate-pulse rounded-sm" />}
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
                <Button variant="outline" size="sm" onClick={addHousehold}>
                  Add household
                </Button>
              }
            />
          }
        >
          <div class="flex flex-col gap-6">
            <For each={store.draft.families}>
              {(family, index) => (
                <FamilyCard
                  family={family}
                  events={eventColumns()}
                  errorsByKey={errorsByKey()}
                  store={store}
                  compact={compact}
                  clipped={clipped}
                  nameRef={(el) => {
                    nameFields.set(family.key, el);
                    onCleanup(() => nameFields.delete(family.key));
                    if (index() === 0) queueMicrotask(measureHeads);
                  }}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Preview modal (the shared ChangePreview) — shown after a successful
          preview, gates the apply. */}
      {/* Was a `fixed inset-0 z-50` scrim in a `<Portal>`, portalled because the
          dashboard shell sets `container-type` on its layout boxes, which brings
          `contain: layout` and makes them the containing block for
          `position: fixed` descendants. A top-layer dialog is outside every
          stacking context, so there is nothing to escape and nothing to portal
          past — and it brings the focus trap and Escape this never had.

          `heldWhileClosing` because the body cannot render without a plan, and
          confirming sets `preview()` null: without it the modal would fade out
          as an empty box. */}
      <Modal
        open={preview() !== null}
        onClose={() => setPreview(null)}
        label="Review changes before applying"
        class="w-full max-w-lg overflow-y-auto"
      >
        <Show when={shownPreview()}>
          {(p) => (
            <>
              <ChangePreview
                plan={p().plan}
                warnings={p().warnings}
                clears={p().clears}
                emailAttestations={p().emailAttestations ?? 0}
                busy={busy()}
                confirmLabel="Confirm & save"
                onConfirm={(choice) => void handleApply(choice)}
                onCancel={() => setPreview(null)}
              />
              {/* An apply error has to render HERE as well as in the sticky
                  bar: the bar sits behind this dialog, so a failed apply
                  otherwise looked like nothing happened at all. */}
              <Show when={saveError()}>
                <Notice tone="danger" alert class="mt-4">
                  {saveError()}
                </Notice>
              </Show>
            </>
          )}
        </Show>
      </Modal>

      {/* Sticky unsaved-changes bar (§8) — only while dirty. */}
      <Show when={store.loaded() && store.dirty()}>
        {/* Portalled for the same containment reason as the preview modal above —
            a `fixed` bar inside a `container-type` box pins to that box, not the
            viewport, so it would ride inside the panel instead of the window. */}
        <Portal>
          <div class="border-border bg-surface/95 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur">
            <div class="page-frame flex flex-wrap items-center justify-between gap-3 py-3">
              <span class="font-body text-text-muted text-ui-sm">
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
                    setReplayNotes([]);
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
                <Notice tone="danger" alert>
                  <p>{saveError()}</p>
                  <Show when={stale()}>
                    <Button
                      class="mt-3"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleKeepEdits()}
                      disabled={busy()}
                    >
                      Reload and keep my edits
                    </Button>
                  </Show>
                </Notice>
              </div>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

/** The ground a card sits on — `bg-surface/30` over the page — as one opaque
 *  paint, for the card's stuck header, which rows scroll beneath. */
const CARD_GROUND =
  "bg-bg bg-[image:linear-gradient(color-mix(in_oklab,var(--color-surface)_30%,transparent),color-mix(in_oklab,var(--color-surface)_30%,transparent))]";

/** The column widths, one `<col>` each, for a card's table and its strip. */
function EditorColumns(props: { events: { key: string }[] }) {
  return (
    <colgroup>
      <col style={{ width: `${COLUMNS.first}rem` }} />
      <col style={{ width: `${COLUMNS.last}rem` }} />
      <col style={{ width: `${COLUMNS.nickname}rem` }} />
      <col style={{ width: `${COLUMNS.email}rem` }} />
      <For each={props.events}>{() => <col style={{ width: `${COLUMNS.event}rem` }} />}</For>
      <col style={{ width: `${COLUMNS.actions}rem` }} />
    </colgroup>
  );
}

/** An event head cut short by its column: a button that opens the whole name.
 *  Dotted underline, the portal's mark for "there is more here". */
function ClippedHead(props: SafeProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      class="block w-full truncate uppercase underline decoration-dotted underline-offset-4"
    />
  );
}

const STRIP_HEAD =
  "font-body text-gold-ink text-ui-xs tracking-ui-wider h-(--head-strip-h) px-4 py-0 align-middle font-normal whitespace-nowrap uppercase";

/**
 * One editable household card: its header — the name field, the claim code
 * and delete, then the column heads — and its guests as rows in a per-guest ×
 * per-event attendance matrix, plus an "Add guest" action.
 *
 * The header sticks under the view bar while the card is on screen and lets
 * go at its end; it paints the card's ground opaque, so the rows pass beneath.
 * Its column heads are a copy of the table's in a table of their own with the
 * same columns, kept level with the rows as the table scrolls sideways (the
 * editor's one scroll listener). The table's own heads stay for assistive
 * technology, their words hidden and their row given no height.
 */
function FamilyCard(props: {
  family: DraftFamily;
  events: { key: string; name: string }[];
  errorsByKey: Map<string, string[]>;
  store: ReturnType<typeof createGuestEventDraft>;
  compact: Accessor<boolean>;
  clipped: Accessor<ReadonlySet<string>>;
  nameRef: (el: HTMLInputElement) => void;
}) {
  const famErrors = () => props.errorsByKey.get(props.family.key) ?? [];
  const width = () => tableWidth(props.events.length);
  const eventName = (evt: { name: string }) => evt.name || "Untitled event";

  const code = () => (
    <Show
      when={props.family.publicId}
      fallback={
        <span class="font-body text-gold/70 border-gold/30 text-ui-xs tracking-ui-widest shrink-0 rounded-sm border px-1.5 py-0.5 uppercase not-italic">
          New — code minted on save
        </span>
      }
    >
      <span
        class="text-text-muted text-ui-xs shrink-0 font-mono"
        title="This household's claim code — deleting the household disables it."
      >
        {props.family.publicId}
      </span>
    </Show>
  );

  // Quiet, not danger: nothing is destroyed on this click. It marks the
  // household for removal, and `ChangePreview` spells out the cost before
  // anything is applied. A red button per card would shout louder than what
  // the button does.
  const remove = () => (
    <Button
      variant="quiet"
      size="sm"
      class="shrink-0"
      onClick={() => props.store.removeFamily(props.family.key)}
      title="Delete this household. Its claim code is disabled and any RSVPs are discarded — you'll confirm the impact before it's applied."
    >
      Delete household
    </Button>
  );

  return (
    <div
      data-edit-card
      class="border-border bg-surface/30 flex flex-col rounded-sm border px-4 pb-4"
      style={{ "--edit-table-w": width() }}
    >
      <div
        class={`border-border sticky top-[calc(var(--chrome-h)+var(--bar-h,0px))] z-10 -mx-4 border-b px-4 ${CARD_GROUND}`}
      >
        {/* One fixed-height row. On a narrow panel it holds the name alone,
            its label carried by the field itself; the code and delete move
            under the header. */}
        <div class="flex h-(--card-head-h) items-center gap-3">
          <Show when={!props.compact()}>
            <span
              aria-hidden="true"
              class="font-body text-text-muted text-ui-xs tracking-ui-widest shrink-0 uppercase"
            >
              Household
            </span>
          </Show>
          <Input
            ref={props.nameRef}
            size="sm"
            value={props.family.familyName}
            aria-label="Household name"
            placeholder="Household name"
            aria-invalid={famErrors().length > 0}
            onInput={(e) => props.store.renameFamily(props.family.key, e.currentTarget.value)}
            class="min-w-0 flex-1"
          />
          <Show when={!props.compact()}>
            {code()}
            {remove()}
          </Show>
        </div>
        {/* The column heads, for the eye; the table below names its own for
            assistive technology, so the strip is no table to it and its words
            are hidden. An event name too long for its column is cut short
            here, and becomes a button that shows the whole name — by touch or
            keyboard, not hover alone. Scrolled to match the table by the
            editor. */}
        <div data-head-strip class="-mx-4 overflow-hidden">
          <table
            role="presentation"
            class="table-fixed border-separate border-spacing-0 text-left"
            style={{ width: width() }}
          >
            <EditorColumns events={props.events} />
            <thead>
              <tr>
                <th class={STRIP_HEAD}>
                  <span aria-hidden="true">First name</span>
                </th>
                <th class={STRIP_HEAD}>
                  <span aria-hidden="true">Last name</span>
                </th>
                <th class={STRIP_HEAD}>
                  <span aria-hidden="true">Nickname</span>
                </th>
                <th class={STRIP_HEAD}>
                  <span aria-hidden="true">Email</span>
                </th>
                <For each={props.events}>
                  {(evt) => (
                    <th class={`${STRIP_HEAD} text-center`}>
                      <Show
                        when={props.clipped().has(evt.key)}
                        fallback={
                          <span aria-hidden="true" data-event-head={evt.key} class="block truncate">
                            {eventName(evt)}
                          </span>
                        }
                      >
                        <Popover placement="bottom">
                          <PopoverTrigger
                            as={ClippedHead}
                            data-event-head={evt.key}
                            aria-label={`Event: ${eventName(evt)}`}
                          >
                            {eventName(evt)}
                          </PopoverTrigger>
                          <PopoverContent>{eventName(evt)}</PopoverContent>
                        </Popover>
                      </Show>
                    </th>
                  )}
                </For>
                <th class={STRIP_HEAD} />
              </tr>
            </thead>
          </table>
        </div>
      </div>

      <Show when={props.compact()}>
        <div class="flex flex-wrap items-center justify-between gap-3 pt-3">
          {code()}
          {remove()}
        </div>
      </Show>

      <For each={famErrors()}>{(msg) => <p class="text-error text-ui-sm pt-2">{msg}</p>}</For>

      {/* The shared `Table`, which also makes the sideways scroll reachable from
          a keyboard — this is the one table in the portal that grows a column
          per event, so it scrolls in its own box at any width. */}
      <Table
        label={`Guests in ${props.family.familyName || "this household"}`}
        frame="none"
        class={`-mx-4 [&>table]:w-(--edit-table-w) [&>table]:table-fixed ${ROWS_SCROLL_MARGIN}`}
      >
        <EditorColumns events={props.events} />
        {/* The real heads: in the table's layout, their words hidden and the
            row given no height. The strip above is what the eye reads. */}
        <thead>
          <tr>
            <Th srOnly>First name</Th>
            <Th srOnly>Last name</Th>
            <Th srOnly>Nickname</Th>
            <Th srOnly>Email</Th>
            <For each={props.events}>
              {(evt) => (
                <Th align="center" srOnly>
                  {eventName(evt)}
                </Th>
              )}
            </For>
            <Th srOnly>Actions</Th>
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
        <p class="font-body text-text-muted text-ui-sm pt-3">
          No guests in this household yet — its invite code won’t show anyone.
        </p>
      </Show>

      <Button
        variant="outline"
        size="sm"
        class="mt-4 self-start"
        onClick={() => props.store.addGuest(props.family.key)}
      >
        Add guest
      </Button>
    </div>
  );
}

/**
 * A guest's address in the editor. The organiser types one for a guest who
 * has none, or changes one an organiser added; saving asks them to confirm
 * the guest agreed. An address the guest gave themselves on the invite is
 * theirs: it shows as text with Remove, never as a field, and a removal can be
 * undone until the save. With no `email` on the draft row (an API older than
 * addresses) the cell is empty and the draft sends nothing.
 */
function GuestEmailCell(props: {
  guest: DraftGuest;
  store: ReturnType<typeof createGuestEventDraft>;
  /** The row's address is not one address. */
  invalid: boolean;
  /** The id of the row's error list, when it has one. */
  describedBy: string | undefined;
}) {
  const guestsOwn = () => props.guest.emailSource === "guest" && Boolean(props.guest.emailLoaded);
  return (
    <Show when={props.guest.email !== undefined}>
      <Show
        when={guestsOwn()}
        fallback={
          <Input
            size="sm"
            type="email"
            autocomplete="off"
            value={props.guest.email ?? ""}
            aria-label="Email"
            aria-invalid={props.invalid}
            aria-describedby={props.describedBy}
            placeholder="—"
            onInput={(e) =>
              props.store.updateGuest(props.guest.key, { email: e.currentTarget.value })
            }
          />
        }
      >
        <Show
          when={(props.guest.email ?? "").length > 0}
          fallback={
            <span class="text-text-muted text-ui-sm flex flex-wrap items-center gap-x-2">
              Removed on save
              <Button
                variant="bare"
                size="sm"
                type="button"
                onClick={() =>
                  props.store.updateGuest(props.guest.key, { email: props.guest.emailLoaded ?? "" })
                }
                aria-label={`Keep ${props.guest.firstName || "the guest"}’s email address`}
              >
                Undo
              </Button>
            </span>
          }
        >
          <span class="text-ui-sm flex flex-wrap items-center gap-x-2">
            <span class="text-text break-all">{props.guest.email}</span>
            <span class="text-text-muted">added by the guest</span>
            <Button
              variant="bareDanger"
              size="sm"
              type="button"
              onClick={() => props.store.updateGuest(props.guest.key, { email: "" })}
              aria-label={`Remove ${props.guest.firstName || "the guest"}’s email address`}
            >
              Remove email
            </Button>
          </span>
        </Show>
      </Show>
    </Show>
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
  const errorsId = createUniqueId();
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
        <Td>
          <GuestEmailCell
            guest={props.guest}
            store={props.store}
            invalid={props.errors.includes(EMAIL_ERROR)}
            describedBy={props.errors.length > 0 ? errorsId : undefined}
          />
        </Td>
        <For each={props.events}>
          {(evt) => (
            <Td align="center">
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
        <Td align="end">
          <Button
            variant="bareDanger"
            size="sm"
            type="button"
            onClick={() => props.store.removeGuest(props.guest.key)}
            aria-label={`Remove ${props.guest.firstName || "guest"}`}
          >
            Remove
          </Button>
        </Td>
      </tr>
      <Show when={props.errors.length > 0}>
        <tr>
          <td id={errorsId} colspan={4 + props.events.length + 1} class="px-2 pb-2">
            <For each={props.errors}>{(msg) => <p class="text-error text-ui-sm">{msg}</p>}</For>
          </td>
        </tr>
      </Show>
    </>
  );
}
