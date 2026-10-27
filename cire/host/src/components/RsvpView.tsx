import {
  formatDietaryCell,
  ORGANISER_DIETARY_ATTESTATION,
  ORGANISER_PLUS_ONE_DIETARY_ATTESTATION,
} from "@cire/dietary";
import Button from "@cire/ui/button";
import DietaryPresetsInline from "@cire/ui/dietary-presets";
import DietaryPresets from "@cire/ui/dietary-presets-popover";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Table, Td, Th } from "@shared/ui/ui/table";
import { Tooltip } from "@shared/ui/ui/tooltip";
import ArrowDown from "lucide-solid/icons/arrow-down";
import ArrowUp from "lucide-solid/icons/arrow-up";
import ChevronsUpDown from "lucide-solid/icons/chevrons-up-down";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  mapArray,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { downloadBlob } from "../lib/download";
import { haptic } from "../lib/haptics";
import { CIRE_MARKETING_URL } from "../lib/osn";
import { fetchRsvpChangeRows, markRsvpChangesSeen, newRowCheck } from "../lib/rsvp-changes";
import {
  filterRows,
  mergeRows,
  nextSort,
  plusOneMarker,
  RSVP_FILTERS,
  type RsvpFilterEvent,
  type RsvpFilterKey,
  type RsvpRow,
  type RsvpRowStatus,
  type RsvpSort,
  type RsvpSortKey,
  type RsvpStatus,
  sortRows,
  statusCounts,
} from "../lib/rsvp-filter";
import { applySavedReply, isSavedReply } from "../lib/rsvp-save";
import { chromeFoot, scrollToResults } from "../lib/scroll-to-results";
import { createSlidingPill } from "../lib/sliding-pill";
import SectionIntro from "./SectionIntro";
import { createCompact, holdUntilReady, ViewBar } from "./ViewBar";

interface RsvpViewProps {
  weddingId: string;
  /** Owner/editor may record RSVPs; a viewer sees the read-only summary only. */
  canEdit?: boolean;
  /** Owner only: offered the RSVP download, which the API gates with
   *  `weddingOwner()`. */
  canManage?: boolean;
  /** Names the downloaded file, as the Guests tab names its own; absent, the
   *  wedding id does, as in the API's Content-Disposition. */
  weddingSlug?: string;
  /** The event to show, from the page address. Absent, or naming no event the
   *  API returned: the first event. */
  event?: string;
  /** A host picked an event, reported so the address can name it. */
  onEvent?: (eventId: string) => void;
  /** Drawn alone, outside the module shell: whether to draw the narrow layout.
   *  Inside the shell the panel's width decides. */
  compact?: boolean;
}

/** The narrowest panel the table fits, by its fixed columns plus 7rem of
 *  Dietary: an editor's five columns, a viewer's four. Narrower, the rows stack. */
const TABLE_MIN_REM = { editor: 45, viewer: 37 } as const;

interface RsvpViewEvent extends RsvpFilterEvent {
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
}

/** Human label + badge styling per row status. "No reply" is deliberately the
 *  quiet one: it is the most common state early on, and a loud badge on every
 *  second row would drown the answers that did come in. */
const STATUS_META = {
  attending: { label: "Attending", class: "bg-gold text-bg" },
  declined: { label: "Declined", class: "border-error/40 text-error border" },
  maybe: { label: "Maybe", class: "border-gold/40 text-gold border" },
  none: { label: "No reply", class: "border-border text-text-muted border" },
} satisfies Record<RsvpRowStatus, { label: string; class: string }>;

/** The column head that sorts, by column. */
const SORT_LABEL = {
  guest: "Guest",
  household: "Household",
} satisfies Record<RsvpSortKey, string>;

const SORT_ICON_CLASS = "size-3.5 shrink-0";

// `h-7`, the height of the small search box beside them, so the bar's second
// row is one height whether it holds the chips or, on a phone, two selects.
const CHIP_CLASS =
  "border-border hover:border-gold focus-visible:border-gold focus-visible:ring-gold/40 " +
  "font-body text-text-muted aria-pressed:border-gold aria-pressed:text-gold " +
  "flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-ui-sm tracking-ui-wide " +
  "uppercase transition outline-none focus-visible:ring-2";

/** The phone's sort and reply pickers: native selects, at the search box's height. */
const SELECT_CLASS =
  "border-border bg-bg text-text font-body text-ui-sm h-7 min-w-0 rounded-sm border px-2";

/** What the sort select offers, in `RsvpSort` terms. */
const SORT_CHOICES = [
  { value: "", label: "As listed", sort: null },
  { value: "guest:ascending", label: "Guest A–Z", sort: { key: "guest", direction: "ascending" } },
  {
    value: "guest:descending",
    label: "Guest Z–A",
    sort: { key: "guest", direction: "descending" },
  },
  {
    value: "household:ascending",
    label: "Household A–Z",
    sort: { key: "household", direction: "ascending" },
  },
  {
    value: "household:descending",
    label: "Household Z–A",
    sort: { key: "household", direction: "descending" },
  },
] as const satisfies readonly { value: string; label: string; sort: RsvpSort | null }[];

/** Where a stuck head row's bottom is, for a focused control's scroll margin:
 *  the top bar, the view bar, and the head row with a little to spare. */
const ROW_SCROLL_MARGIN =
  "[&_:is(button,input,select,textarea,a)]:scroll-mt-[calc(var(--chrome-h)+var(--bar-h,0px)+3rem)]";
/** Likewise for the stacked rows on a phone, which have no head row. */
const BLOCK_SCROLL_MARGIN =
  "[&_:is(button,input,select,textarea,a)]:scroll-mt-[calc(var(--chrome-h)+var(--bar-h,0px)+0.5rem)]";

/** Identifies the row being edited (event + guest) so only one form is open. */
interface EditTarget {
  eventId: string;
  guestId: string;
  guestName: string;
  status: RsvpStatus;
  dietary: string;
  /** May hold a key this build does not know; see `RsvpFilterGuest`. */
  dietaryPresets: readonly string[];
  /** A plus-one's reply: dietary data on it is attested in the plus-one's
   *  wording, for the name the form showed. */
  plusOne: boolean;
}

/** API refusals that mean the page was built or loaded against other copy or
 *  another plus-one, so a reload is the fix. */
const STALE_PAGE_ERRORS = new Set([
  "dietary_attestation_outdated",
  "dietary_attestation_mismatch",
  "plus_one_dietary_unavailable",
  "plus_one_changed",
]);

/** The attestation the organiser makes for this reply: the plus-one's own
 *  wording on a plus-one's reply, the guest's on anyone else's. */
function attestationFor(target: EditTarget) {
  return target.plusOne ? ORGANISER_PLUS_ONE_DIETARY_ATTESTATION : ORGANISER_DIETARY_ATTESTATION;
}

/**
 * In-dashboard RSVP summary, one event at a time. A tab list picks the event,
 * and a search box and status chips act on that event; all three sit in the
 * module's view bar, which sticks under the top bar (`ViewBar.tsx`). The
 * event's panel holds its status tally and every guest invited to it — those
 * who replied, with status + dietary + a provenance badge (organiser-entered,
 * or household-entered for a plus-one, vs guest-submitted), and those who have
 * not, as "No reply" rows in the same list. A plus-one's row names the guest
 * who brought them. The Guest and Household heads sort the list. The table
 * scrolls with the page and its head row sticks under the view bar; on a panel
 * too narrow for its columns the rows stack instead, and the sort and reply
 * filter become selects.
 *
 * Editors get a "Record / Edit" button in each row to enter a phone/paper RSVP
 * on a guest's behalf — the API stamps such rows
 * `consent_source='organiser_attested'` and they VISIBLY OVERWRITE a prior
 * guest reply (platform-plan §3.3). A save that leaves the dietary fields as
 * they were sends the status only, and the API keeps the stored dietary answer
 * and whoever gave it. The attestation box opens unticked and appears only once
 * the dietary answer is edited; on a plus-one's reply it speaks of the
 * plus-one, with a line under it asking the organiser to share the privacy
 * page. Viewers see the same list, read-only.
 */
export default function RsvpView(props: RsvpViewProps) {
  const { authFetch } = useAuth();
  const [state, setState] = createStore<{ events: RsvpViewEvent[] }>({ events: [] });
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // The control bar: a search box and one status chip, applied to every event:
  // the table shows the one on screen, and each tab counts its own. Kept
  // across a switch of event, as is the sort.
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<RsvpFilterKey>("all");
  const [sort, setSort] = createSignal<RsvpSort | null>(null);

  // The event the host chose, seeded from the address and following it on
  // Back/Forward. Written here on a click as well as reported up, so the view
  // also works where nothing writes an address.
  const [chosen, setChosen] = createSignal(untrack(() => props.event));
  createEffect(on(() => props.event, setChosen, { defer: true }));

  // The open editor form (one at a time), plus its transient field state.
  const [edit, setEdit] = createSignal<EditTarget | null>(null);
  const [formStatus, setFormStatus] = createSignal<RsvpStatus>("attending");
  const [formDietary, setFormDietary] = createSignal("");
  const [formPresets, setFormPresets] = createSignal<readonly string[]>([]);
  const [formConsent, setFormConsent] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);

  /** Loads the RSVPs; true when the table has something real to show. */
  const load = async (): Promise<boolean> => {
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/rsvps")));
      if (res.status === 401) {
        redirectToLogin();
        return false;
      }
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body = (await res.json()) as { events: RsvpViewEvent[] };
      setState("events", reconcile(body.events, { key: "id" }));
      return true;
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return false;
      }
      setError("Could not load RSVPs. Is the API running?");
      return false;
    } finally {
      setLoading(false);
    }
  };

  // Rows a guest changed since this organiser last opened the table. Read once
  // per visit beside the RSVPs, so the badges stay put while the organiser
  // records replies; once the table has loaded, those changes are marked seen
  // for this organiser, and the next visit starts clean.
  const [isNewRow, setIsNewRow] = createSignal<(guestId: string, eventId: string) => boolean>(
    () => false,
  );

  // The narrow layout, from the width the module panel has (or, drawn alone,
  // from the `compact` prop). One variant is drawn, never both.
  const layout = createCompact(
    () => (props.canEdit ? TABLE_MIN_REM.editor : TABLE_MIN_REM.viewer),
    () => props.compact ?? false,
  );
  const compact = layout.compact;

  // Hold the module panel open until the first read has landed, so a sub-tab
  // change made deep in another list does not clamp the page meanwhile.
  const ready = holdUntilReady();

  onMount(() => {
    const changes = fetchRsvpChangeRows(authFetch, props.weddingId);
    const first = load();
    void first.finally(ready);
    void Promise.all([first, changes]).then(async ([loaded, feed]) => {
      if (!feed) return false;
      setIsNewRow(() => newRowCheck(feed.rows));
      if (!loaded || feed.markSeq === 0) return false;
      await markRsvpChangesSeen(authFetch, props.weddingId, feed.markSeq);
      return true;
    });
  });

  const hasEvents = () => state.events.length > 0;
  /** A file with no guests in it is only its header row, so none is offered. */
  const hasGuests = () => state.events.some((event) => event.invited > 0);

  // The whole RSVP sheet, every event, as the Guests tab downloads it. Outcome
  // through toasts, as there: a failed download is a thing the owner retries.
  const [exporting, setExporting] = createSignal(false);
  const exportRsvps = async () => {
    if (exporting()) return;
    setExporting(true);
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/rsvps.csv")));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      downloadBlob(`cire-rsvps-${props.weddingSlug ?? props.weddingId}.csv`, await res.blob());
      toast.success("RSVP export downloaded");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("RSVP export failed. Try again.");
    } finally {
      setExporting(false);
    }
  };

  // A store, not a signal: reload writes patch each event's own fields in
  // place, so an event nothing touched keeps its object identity. That alone
  // is not enough, though — a plain memo over the whole event list reads every
  // event's guests, so it subscribes to all of them and re-merges every row
  // when any one changes. `mapArray` is the fix: its callback runs once per
  // event, cached by identity, so the per-event row memos below only re-run
  // for the event whose own guests actually changed. Everything reads
  // `sections()`.
  //
  // Sorted before filtered, so a keystroke only filters: the sort runs again
  // when the rows or the sort change, never while the host types. Every event
  // is filtered, not only the one on screen, because each tab counts its own
  // matches.
  const sections = createMemo(
    mapArray(
      () => state.events,
      (event) => {
        const rows = createMemo(() => mergeRows(event));
        const sorted = createMemo(() => sortRows(rows(), sort()));
        const visible = createMemo(() => filterRows(sorted(), query(), filter()));
        // Every row, whatever the filter: the mark says the event holds a
        // change the host has not seen, which a search does not undo.
        const hasNew = createMemo(() => {
          const isNew = isNewRow();
          return rows().some((row) => isNew(row.guestId, event.id));
        });
        return { event, rows, visible, hasNew };
      },
    ),
  );

  // The event on screen: the one chosen, or the first when none is, or when
  // the one named has gone (a stale link, a deleted event).
  const selected = createMemo(() => {
    const all = sections();
    const id = chosen();
    return all.find((section) => section.event.id === id) ?? all[0];
  });
  const selectedIndex = () => {
    const current = selected();
    return current ? sections().indexOf(current) : -1;
  };

  const counts = createMemo(() => statusCounts(selected()?.rows() ?? []));
  const shownCount = () => selected()?.visible().length ?? 0;
  const filtering = () => query().trim().length > 0 || filter() !== "all";

  const selectEvent = (eventId: string) => {
    setChosen(eventId);
    props.onEvent?.(eventId);
  };

  const openEditor = (
    eventId: string,
    guest: { guestId: string; firstName: string; lastName: string; plusOneOf: string | null },
    existing?: { status: RsvpStatus; dietary: string; dietaryPresets: readonly string[] },
  ) => {
    setFormError(null);
    setFormStatus(existing?.status ?? "attending");
    setFormDietary(existing?.dietary ?? "");
    setFormPresets(existing?.dietaryPresets ?? []);
    // Never ticked on opening: a box that opens ticked is no attestation, and
    // a save that leaves the dietary answer alone needs none.
    setFormConsent(false);
    setEdit({
      eventId,
      guestId: guest.guestId,
      guestName: `${guest.firstName} ${guest.lastName}`,
      status: existing?.status ?? "attending",
      dietary: existing?.dietary ?? "",
      dietaryPresets: existing?.dietaryPresets ?? [],
      plusOne: guest.plusOneOf !== null,
    });
  };

  /** Open the editor on a list row: prefilled when there is a reply to edit,
   *  blank when the guest has said nothing yet. */
  const openRow = (eventId: string, row: RsvpRow) => {
    if (row.responded && row.status !== "none") {
      openEditor(eventId, row, {
        status: row.status,
        dietary: row.dietary,
        dietaryPresets: row.dietaryPresets,
      });
      return;
    }
    openEditor(eventId, row);
  };

  /** Whether the form's dietary answer differs from the stored one. Presets
   *  compare as sets: the picker may hold them in another order. */
  const dietaryEdited = (target: EditTarget): boolean => {
    if (formDietary().trim() !== target.dietary.trim()) return true;
    const stored = new Set(target.dietaryPresets);
    const now = new Set(formPresets());
    return stored.size !== now.size || [...now].some((key) => !stored.has(key));
  };

  const closeEditor = () => {
    setEdit(null);
    setSaving(false);
    setFormError(null);
  };

  const isEditing = (eventId: string, guestId: string) => {
    const e = edit();
    return e !== null && e.eventId === eventId && e.guestId === guestId;
  };

  // A filter that hides the row an editor is open on would otherwise leave the
  // form floating under a row that is no longer there — and a Save would write
  // an RSVP the host can't see. Close it instead. A switch of event does not
  // close it: the form belongs to its own event, is not drawn while another
  // one shows, and comes back with what was typed when the host returns.
  createEffect(() => {
    const target = edit();
    if (!target) return;
    const rows = sections()
      .find((section) => section.event.id === target.eventId)
      ?.visible();
    if (!rows?.some((row) => row.guestId === target.guestId)) closeEditor();
  });

  // The count a screen reader hears, held back until the typing stops. Read
  // live, a status region interrupts on every keystroke and says a number the
  // host is already halfway past; the printed line beside it stays immediate,
  // because a sighted host reading a stale number is the worse failure.
  const [announcement, setAnnouncement] = createSignal("");
  createEffect(() => {
    const message = filtering() ? showing() : "";
    const timer = setTimeout(() => setAnnouncement(message), 450);
    onCleanup(() => clearTimeout(timer));
  });

  /** The status line: how much of the event on screen the search and chip
   *  leave, naming the event, since that is all they act on. */
  function showing() {
    return `Showing ${shownCount()} of ${counts().all} guests for ${selected()?.event.name ?? ""}.`;
  }

  // ── The event tabs ────────────────────────────────────────────────────────
  // Ids carry a per-view prefix, so they can never meet the module shell's
  // `subtab-*` / `subpanel-*` around this view.
  const idPrefix = `rsvp-${createUniqueId()}`;
  const panelId = `${idPrefix}-panel`;
  const tabId = (index: number) => `${idPrefix}-tab-${index}`;

  // Roving tabindex, as in the module shell's own strip: only the selected tab
  // is a tab stop, and the arrow keys move focus between the rest.
  const tabRefs: HTMLButtonElement[] = [];
  const [strip, setStrip] = createSignal<HTMLElement>();
  const pill = createSlidingPill(() => selected()?.event.id ?? "");

  /**
   * Scroll the strip, and only the strip, until a tab is wholly in it.
   * `scrollIntoView` and a plain `focus()` would scroll the page too, which on
   * a deep link means the page jumps as it loads.
   */
  function reveal(tab: HTMLElement | undefined) {
    const track = strip();
    if (!tab || !track) return;
    // The tabs are laid out in the track (it is `relative`), so offsetLeft is
    // in the track's scrolled coordinates. 4px is the track's padding.
    const start = tab.offsetLeft - 4;
    const end = tab.offsetLeft + tab.offsetWidth + 4;
    if (start < track.scrollLeft) track.scrollLeft = start;
    else if (end > track.scrollLeft + track.clientWidth) track.scrollLeft = end - track.clientWidth;
  }

  // The chosen tab in view whenever the choice changes, and once the strip
  // first mounts — which is after the load, so a deep-linked tab far along the
  // strip is shown rather than left past its edge.
  createEffect(() => {
    const index = selectedIndex();
    if (strip()) reveal(tabRefs[index]);
  });

  function focusTab(index: number) {
    const count = sections().length;
    if (count === 0) return;
    const tab = tabRefs[((index % count) + count) % count];
    tab?.focus({ preventScroll: true });
    reveal(tab);
  }

  function onTabKeyDown(event: KeyboardEvent, index: number) {
    // Focus only — Enter and Space fall through to the button's native click,
    // which is what selects. A big event is not drawn in an instant, and each
    // selection writes the address, so passing over a tab must not choose it.
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusTab(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusTab(sections().length - 1);
    }
  }

  // A search, a reply filter, a sort or another event redraws the list. If the
  // host had scrolled into it, the page brings the list's top back to the foot
  // of the stuck chrome (`lib/scroll-to-results.ts`); otherwise nothing moves.
  // Focus stays where it was. The search acts at once here: the list filters
  // as the host types.
  let results: HTMLDivElement | undefined;
  createEffect(
    on(
      [query, filter, sort, () => selected()?.event.id],
      () => {
        if (results?.isConnected) scrollToResults(results, chromeFoot(results));
      },
      { defer: true },
    ),
  );

  /** The sort a column head is showing, as `aria-sort` spells it. */
  const ariaSort = (key: RsvpSortKey) => {
    const current = sort();
    return current?.key === key ? current.direction : undefined;
  };

  /** A sortable column head's control. A button inside the `<th>`, which
   *  carries `aria-sort`, as the APG sortable table does. */
  const sortButton = (key: RsvpSortKey) => (
    <button
      type="button"
      onClick={() => setSort(nextSort(sort(), key))}
      // `uppercase` again: a button does not inherit the head's transform.
      class="hover:text-text -mx-1 inline-flex items-center gap-1.5 rounded-sm px-1 uppercase transition-colors duration-(--dur-fast) ease-(--ease-out)"
    >
      {SORT_LABEL[key]}
      <Show
        when={ariaSort(key)}
        fallback={
          <ChevronsUpDown
            aria-hidden="true"
            strokeWidth={1.75}
            class={`${SORT_ICON_CLASS} opacity-50`}
          />
        }
      >
        {(direction) => (
          <Show
            when={direction() === "ascending"}
            fallback={<ArrowDown aria-hidden="true" strokeWidth={1.75} class={SORT_ICON_CLASS} />}
          >
            <ArrowUp aria-hidden="true" strokeWidth={1.75} class={SORT_ICON_CLASS} />
          </Show>
        )}
      </Show>
    </button>
  );

  const save = async () => {
    const target = edit();
    if (!target) return;
    const dietary = formDietary().trim();
    const dietaryPresets = formPresets();
    // Unedited, the save is status-only and the API keeps the stored answer
    // with its consent record; nothing is attested.
    const edited = dietaryEdited(target);
    // Presets are special-category exactly as the free text is, so either one
    // being present is what the attestation has to cover.
    const hasDietaryData = dietary.length > 0 || dietaryPresets.length > 0;
    if (edited && hasDietaryData && !formConsent()) {
      haptic("reject");
      setFormError(
        `Confirm ${target.plusOne ? "the plus-one" : "the guest"} consented before storing dietary requirements.`,
      );
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await authFetch(
        apiUrl(
          weddingPath(
            props.weddingId,
            `/guests/${encodeURIComponent(target.guestId)}/rsvps/${encodeURIComponent(target.eventId)}`,
          ),
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            edited
              ? {
                  status: formStatus(),
                  dietary,
                  dietaryPresets,
                  dietaryConsent: hasDietaryData ? formConsent() : false,
                  // The version of the words beside the box, and for a plus-one
                  // the name it was shown for. The API refuses dietary data
                  // unless the version is the one it stamps for this person
                  // and the name is the row's, so a stale portal cannot store
                  // evidence of copy it did not show.
                  dietaryAttestation: hasDietaryData ? attestationFor(target).version : "",
                  dietaryAttestedName: target.plusOne && hasDietaryData ? target.guestName : "",
                }
              : { status: formStatus() },
          ),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (res.status === 403) {
        haptic("reject");
        setFormError("You don't have permission to record RSVPs.");
        setSaving(false);
        return;
      }
      if (!res.ok) {
        haptic("reject");
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setFormError(
          typeof body?.error === "string" && STALE_PAGE_ERRORS.has(body.error)
            ? "This page is out of date. Reload it and try again."
            : "Could not save this RSVP. Please try again.",
        );
        setSaving(false);
        return;
      }
      // Recorded. The PUT answers with the stored row, which patches that one
      // row and its event's tallies in place; only a page out of step with
      // the API (the guest in neither list) reloads. The buzz is what tells
      // the host the save landed, not the redraw.
      haptic("commit");
      closeEditor();
      const body = (await res.json().catch(() => null)) as { rsvp?: unknown } | null;
      const at = state.events.findIndex((event) => event.id === target.eventId);
      const event = at >= 0 ? state.events[at] : undefined;
      const next = event && isSavedReply(body?.rsvp) ? applySavedReply(event, body.rsvp) : null;
      if (next) setState("events", at, reconcile(next, { key: "guestId" }));
      else await load();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setFormError("Could not save this RSVP. Please try again.");
      setSaving(false);
    }
  };

  /** The event tab strip, lent to the view bar's first row. */
  const eventStrip = () => (
    // One event at a time. The strip scrolls sideways rather than wrapping: a
    // wedding with many events keeps one row of tabs.
    <div
      ref={(el) => {
        setStrip(el);
        pill.track(el);
      }}
      role="tablist"
      aria-label="Events"
      class="border-border bg-surface/30 relative mr-auto flex max-w-full min-w-0 [scrollbar-width:thin] gap-1 overflow-x-auto rounded-sm border p-1"
    >
      {/* The selection, as one box that travels — the module shell's strip,
          reused. */}
      <span
        aria-hidden="true"
        class="bg-gold/12 pointer-events-none absolute top-0 left-0 rounded-sm"
        style={pill.style()}
      />
      <For each={sections()}>
        {(section, index) => {
          const isSelected = () => selected() === section;
          const shown = () => section.visible().length;
          // The tab's whole name, in sentence case. Chrome would carry the
          // label's `uppercase` into a name read from the text, and put a
          // space before each comma between the flex children.
          const name = () =>
            `${section.event.name}, ${shown()} ${
              filtering() ? "matching" : shown() === 1 ? "guest" : "guests"
            }${section.hasNew() ? ", changed since you last looked" : ""}`;
          return (
            <button
              ref={(el) => {
                tabRefs[index()] = el;
                pill.item(section.event.id)(el);
              }}
              type="button"
              role="tab"
              id={tabId(index())}
              aria-controls={panelId}
              aria-selected={isSelected()}
              tabindex={isSelected() ? 0 : -1}
              aria-label={name()}
              onKeyDown={(event) => onTabKeyDown(event, index())}
              onClick={() => selectEvent(section.event.id)}
              class={`font-body text-ui-xs tracking-ui-wider relative flex shrink-0 items-center gap-2 rounded-sm px-3.5 py-1.5 whitespace-nowrap uppercase transition-colors duration-(--dur-fast) ease-(--ease-out) ${
                isSelected() ? "text-gold" : "text-text-muted hover:text-text hover:bg-surface/60"
              }`}
            >
              {section.event.name}
              {/* The rows this tab would show: the whole list, or what the
                  search and chip leave of it — so a search run on one event
                  still says which others it would find guests in. */}
              <span class="text-text font-mono tracking-normal">{shown()}</span>
              {/* Opening the table marks every event's changes seen, so an
                  event not on screen says it holds some, in a word. */}
              <Show when={section.hasNew()}>
                <span class="bg-gold/15 text-gold tracking-ui-wider rounded-sm px-1.5 py-0.5">
                  New
                </span>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );

  /**
   * The search and the reply filter, lent to the view bar's second row. They
   * act on the event on screen, and say so: the search names the event's tab
   * panel through `aria-controls`, and both name the event.
   */
  const controls = (section: () => NonNullable<ReturnType<typeof selected>>) => (
    <>
      <Field
        label={`Search ${section().event.name} guests`}
        labelHidden
        class={compact() ? "min-w-0 flex-1" : "min-w-40 flex-1"}
      >
        {(field) => (
          <Input
            {...field}
            size="sm"
            type="search"
            aria-controls={panelId}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder={
              compact()
                ? "Search guests…"
                : `Search ${section().event.name} by name, household, code or dietary note…`
            }
          />
        )}
      </Field>
      <Show
        when={compact()}
        fallback={
          <div
            class="flex flex-wrap gap-2"
            role="group"
            aria-label={`Filter ${section().event.name} by reply`}
          >
            <For each={RSVP_FILTERS}>
              {(chip) => (
                <button
                  type="button"
                  class={CHIP_CLASS}
                  aria-pressed={filter() === chip.key}
                  onClick={() => setFilter(chip.key)}
                >
                  {chip.label}
                  <span class="text-text text-ui-xs font-mono">{counts()[chip.key]}</span>
                </button>
              )}
            </For>
          </div>
        }
      >
        {/* A phone has no head row to sort from and no room for five chips:
            the same two choices, as selects. */}
        <select
          class={`${SELECT_CLASS} max-w-24`}
          aria-label={`Filter ${section().event.name} by reply`}
          value={filter()}
          onChange={(e) => setFilter(e.currentTarget.value as RsvpFilterKey)}
        >
          <For each={RSVP_FILTERS}>
            {(chip) => (
              <option value={chip.key}>
                {chip.label} ({counts()[chip.key]})
              </option>
            )}
          </For>
        </select>
        <select
          class={`${SELECT_CLASS} max-w-24`}
          aria-label="Sort guests"
          value={sort() ? `${sort()!.key}:${sort()!.direction}` : ""}
          onChange={(e) =>
            setSort(SORT_CHOICES.find((c) => c.value === e.currentTarget.value)?.sort ?? null)
          }
        >
          <For each={SORT_CHOICES}>
            {(choice) => <option value={choice.value}>{choice.label}</option>}
          </For>
        </select>
      </Show>
    </>
  );

  /** The badges after a guest's name, each explaining itself through
   *  `Tooltip`: hidden text a screen reader gets once, and the same words in
   *  a panel on hover. Never a `title`: beside the text, Chrome would hand it
   *  to a screen reader a second time, as the badge's description. */
  const badges = (row: RsvpRow, eventId: string) => (
    <>
      <Show when={isNewRow()(row.guestId, eventId)}>
        {" "}
        <Tooltip text="Changed by the guest since you last looked">
          <span class="bg-gold/15 text-gold text-ui-xs tracking-ui-wider ml-1 inline-block rounded-sm px-1.5 py-0.5 uppercase">
            New
          </span>
        </Tooltip>
      </Show>
      <Show when={row.consentSource === "organiser_attested"}>
        {" "}
        <Tooltip text="Recorded by a host (phone/paper RSVP)">
          <span class="border-gold/40 text-gold text-ui-xs tracking-ui-wider ml-1 inline-block rounded-sm border px-1.5 py-0.5 uppercase">
            Host-entered
          </span>
        </Tooltip>
      </Show>
      <Show when={row.statusRecordedByHost && row.consentSource !== "organiser_attested"}>
        {" "}
        <Tooltip text="A host last set this status. The dietary requirements are still the ones the guest or their household gave.">
          <span class="border-gold/40 text-gold text-ui-xs tracking-ui-wider ml-1 inline-block rounded-sm border px-1.5 py-0.5 uppercase">
            Host-updated
          </span>
        </Tooltip>
      </Show>
      <Show when={row.consentSource === "inviter_attested"}>
        {" "}
        <Tooltip text="Given by the household that brought them, not by the plus-one. A host may have changed the status since; the dietary requirements are the household's.">
          <span class="border-border text-text-muted text-ui-xs tracking-ui-wider ml-1 inline-block rounded-sm border px-1.5 py-0.5 uppercase">
            Household-entered
          </span>
        </Tooltip>
      </Show>
      <Show when={row.submittedBy}>
        {(by) => (
          <span class="font-body text-text-muted text-ui-xs mt-0.5 block">
            Answered by {by().firstName}
            <Show when={by().viaLink}>
              {" "}
              <Tooltip text="Sent from a signed-in linked musubi account">
                <span class="border-border ml-0.5 inline-block rounded-sm border px-1 align-baseline uppercase">
                  linked musubi
                </span>
              </Tooltip>
            </Show>
          </span>
        )}
      </Show>
      {/* Its own line, and free to wrap: the column is fixed, and an
          inviter's name is as long as any guest's. */}
      <Show when={row.plusOneOf !== null}>
        <span class="font-body text-gold-ink text-ui-xs mt-0.5 block">{plusOneMarker(row)}</span>
      </Show>
    </>
  );

  const statusBadge = (row: RsvpRow) => (
    <span
      class={`font-body text-ui-xs tracking-ui-widest inline-block rounded-sm px-1.5 py-0.5 uppercase ${STATUS_META[row.status].class}`}
    >
      {STATUS_META[row.status].label}
    </span>
  );

  /** The whole dietary answer, presets and free text, rendered the way the
   *  caterer's sheet renders it — a preset-only reply is not blank. */
  const dietaryCell = (row: RsvpRow) => (
    <Show
      when={formatDietaryCell(row.dietaryPresets, row.dietary)}
      fallback={<span class="text-text-muted">--</span>}
    >
      {(cell) => cell()}
    </Show>
  );

  const replyButton = (eventId: string, row: RsvpRow) => (
    <Button
      variant="quiet"
      size="sm"
      type="button"
      aria-label={`${row.responded ? "Edit" : "Record"} reply for ${row.firstName} ${row.lastName}`}
      onClick={() => openRow(eventId, row)}
    >
      {row.responded ? "Edit" : "Record"}
    </Button>
  );

  /** The head row's offset: under the top bar and the view bar. */
  const HEAD_TOP = "top-[calc(var(--chrome-h)+var(--bar-h,0px))]";

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="RSVPs"
        title="Replies at a glance"
        actions={
          <Show when={props.canManage && !loading() && !error() && hasGuests()}>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void exportRsvps()}
              disabled={exporting()}
            >
              {exporting() ? "Exporting…" : "Download RSVPs (CSV)"}
            </Button>
          </Show>
        }
      />

      {/* What the view lends the bar. While the replies load, a placeholder
          the size of each row holds its place, so the bar does not grow under
          the host when they land. */}
      <Show
        when={!loading()}
        fallback={
          <>
            <ViewBar slot="end">
              <div class="bg-surface/60 mr-auto h-9 w-56 max-w-full min-w-0 animate-pulse rounded-sm" />
            </ViewBar>
            <ViewBar slot="row2">
              <div class="bg-surface/60 h-7 w-full animate-pulse rounded-sm" />
            </ViewBar>
          </>
        }
      >
        <Show when={!error() && hasEvents() && selected()}>
          {(section) => (
            <>
              <ViewBar slot="end">{eventStrip()}</ViewBar>
              <ViewBar slot="row2">{controls(section)}</ViewBar>
            </>
          )}
        </Show>
      </Show>

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3]}>
            {() => <div class="bg-surface h-30 animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <Notice tone="danger">{error()}</Notice>
      </Show>

      <Show when={!loading() && !error() && !hasEvents()}>
        <EmptyState
          title="No events yet"
          description="Add your events and invite guests — their replies will appear here."
        />
      </Show>

      <Show when={!loading() && !error() && hasEvents() && layout.known()}>
        <Show when={selected()}>
          {(section) => (
            <div
              role="tabpanel"
              id={panelId}
              aria-labelledby={tabId(selectedIndex())}
              class="flex flex-col gap-4"
            >
              {/* The API's own tallies for the event. Not the chip counts: those
                  count the rows listed, and a guest taken off the event after
                  replying keeps a row but is no longer invited. Below the bar,
                  so they scroll away under it with the rest. */}
              <dl class="font-body text-text-muted text-ui-sm flex flex-wrap gap-x-4 gap-y-1">
                <div class="flex items-center gap-1.5">
                  <dt class="text-gold tracking-ui-wider uppercase">Attending</dt>
                  <dd class="text-text font-mono">{section().event.attending}</dd>
                </div>
                <div class="flex items-center gap-1.5">
                  <dt class="tracking-ui-wider uppercase">Declined</dt>
                  <dd class="text-text font-mono">{section().event.declined}</dd>
                </div>
                <div class="flex items-center gap-1.5">
                  <dt class="tracking-ui-wider uppercase">Maybe</dt>
                  <dd class="text-text font-mono">{section().event.maybe}</dd>
                </div>
                <div class="flex items-center gap-1.5">
                  <dt class="tracking-ui-wider uppercase">No reply</dt>
                  <dd class="text-text font-mono">{section().event.noResponse}</dd>
                </div>
                <div class="flex items-center gap-1.5">
                  <dt class="tracking-ui-wider uppercase">Invited</dt>
                  <dd class="text-text font-mono">{section().event.invited}</dd>
                </div>
              </dl>

              {/* Two readings of one fact: the printed count updates as you
                  type, the announced one waits for you to stop. Kept out of
                  the stuck bar, so the bar is one height whatever is typed. */}
              <Show when={filtering()}>
                <p class="font-body text-text-muted text-ui-sm">{showing()}</p>
              </Show>
              <p role="status" class="sr-only">
                {announcement()}
              </p>

              <div ref={results}>
                <Show
                  when={section().rows().length > 0}
                  fallback={
                    <p class="font-body text-text-muted text-ui-sm italic">
                      No guests to show for this event.
                    </p>
                  }
                >
                  <Show
                    when={section().visible().length > 0}
                    fallback={
                      <p class="font-body text-text-muted text-ui-sm italic">
                        No guests match this filter.
                      </p>
                    }
                  >
                    <Show when={compact()} fallback={renderTable(section)}>
                      {renderBlocks(section)}
                    </Show>
                  </Show>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );

  /**
   * The wide layout: one table that scrolls with the page, its head row stuck
   * under the view bar.
   *
   * Fixed layout, so a search that removes rows never makes the browser measure
   * every remaining cell to size the columns again — auto layout does exactly
   * that on each keystroke. The widths below are what it reads instead: room
   * for the widest badge, button and heading in each column, with Dietary
   * taking what is left. The panel is never narrower than their sum and 7rem of
   * Dietary (`TABLE_MIN_REM`): below that the rows stack instead, because a
   * page-scrolling table is clipped, not scrolled.
   *
   * The head row sticks to the page, so the pinned heads paint the page's
   * ground and the rows passing under them never show through. A focused
   * control's scroll margin is the stuck stack's height, so the browser never
   * leaves focus under it.
   */
  function renderTable(section: () => NonNullable<ReturnType<typeof selected>>) {
    return (
      <Table scroll="page" class={`[&>table]:table-fixed ${ROW_SCROLL_MARGIN}`}>
        <caption class="sr-only">RSVPs for {section().event.name}</caption>
        <colgroup>
          <col class="w-48" />
          <col class="w-36" />
          <col class="w-36" />
          <col />
          <Show when={props.canEdit}>
            <col class="w-32" />
          </Show>
        </colgroup>
        <thead>
          <tr>
            <Th aria-sort={ariaSort("guest")} pin="top" class={HEAD_TOP}>
              {sortButton("guest")}
            </Th>
            <Th aria-sort={ariaSort("household")} pin="top" class={HEAD_TOP}>
              {sortButton("household")}
            </Th>
            <Th pin="top" class={HEAD_TOP}>
              Status
            </Th>
            <Th pin="top" class={HEAD_TOP}>
              Dietary
            </Th>
            <Show when={props.canEdit}>
              <Th align="end" pin="top" class={HEAD_TOP}>
                <span class="sr-only">Actions</span>
              </Th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={section().visible()}>
            {(row) => (
              <>
                <tr class="hover:[&>td]:bg-surface">
                  {/* The text columns break a word that will not fit: under
                      fixed layout a long name no longer widens its column, it
                      spills into the next one. */}
                  <Td valign="middle" class="wrap-break-word">
                    {row.firstName} {row.lastName}
                    {badges(row, section().event.id)}
                  </Td>
                  <Td tone="muted" valign="middle" class="wrap-break-word">
                    {row.familyName}
                  </Td>
                  <Td valign="middle">{statusBadge(row)}</Td>
                  <Td tone="muted" valign="middle" class="wrap-break-word">
                    {dietaryCell(row)}
                  </Td>
                  <Show when={props.canEdit}>
                    <Td align="end" valign="middle">
                      {replyButton(section().event.id, row)}
                    </Td>
                  </Show>
                </tr>
                <Show when={props.canEdit && isEditing(section().event.id, row.guestId)}>
                  {renderEditorRow()}
                </Show>
              </>
            )}
          </For>
        </tbody>
      </Table>
    );
  }

  /**
   * The narrow layout: each guest a block — name and badges; household; the
   * reply and the dietary answer; the button — so nothing scrolls sideways
   * on a phone. The editor opens as a block under the guest it edits.
   */
  function renderBlocks(section: () => NonNullable<ReturnType<typeof selected>>) {
    return (
      <ul
        aria-label={`Replies for ${section().event.name}`}
        class={`border-border flex flex-col rounded-sm border ${BLOCK_SCROLL_MARGIN}`}
      >
        <For each={section().visible()}>
          {(row) => (
            <li class="border-border/40 flex flex-col gap-1.5 border-b px-4 py-3 last:border-b-0">
              <div class="flex items-start justify-between gap-3">
                <p class="font-body text-text text-ui-base min-w-0 wrap-break-word">
                  {row.firstName} {row.lastName}
                  {badges(row, section().event.id)}
                </p>
                <Show when={props.canEdit}>
                  <div class="-my-1 shrink-0">{replyButton(section().event.id, row)}</div>
                </Show>
              </div>
              <p class="font-body text-text-muted text-ui-sm wrap-break-word">{row.familyName}</p>
              <div class="font-body text-text-muted text-ui-sm flex flex-wrap items-baseline gap-x-2 gap-y-1">
                {statusBadge(row)}
                <span class="min-w-0 wrap-break-word">{dietaryCell(row)}</span>
              </div>
              <Show when={props.canEdit && isEditing(section().event.id, row.guestId)}>
                {renderEditorBlock()}
              </Show>
            </li>
          )}
        </For>
      </ul>
    );
  }

  /** The editor form body. `guest` names whoever the reply is being recorded
   *  for — the form reads the same whether or not they answered before. */
  function renderEditorForm(guest: { firstName: string; lastName: string }, target: EditTarget) {
    /** The stored dietary answer, which a save that leaves the fields alone keeps. */
    const storedDietary = formatDietaryCell(target.dietaryPresets, target.dietary);
    // Read with Save, so a keyboard or screen-reader user hears what a save
    // keeps where they decide, not only a sighted one.
    const keepsId = createUniqueId();
    const keeps = () => storedDietary !== "" && !dietaryEdited(target);
    return (
      <form
        class="border-gold/30 bg-surface/60 flex flex-col gap-3 rounded-sm border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p class="font-body text-text text-ui-sm">
          Recording for{" "}
          <span class="text-gold">
            {guest.firstName} {guest.lastName}
          </span>
        </p>

        <label class="font-body text-text-muted text-ui-sm tracking-ui-wide flex flex-col gap-1 uppercase">
          Status
          <select
            class="border-border bg-bg text-text text-ui-base rounded-sm border px-2.5 py-1.5 normal-case"
            value={formStatus()}
            onChange={(e) => setFormStatus(e.currentTarget.value as RsvpStatus)}
            disabled={saving()}
          >
            <option value="attending">Attending</option>
            <option value="declined">Declined</option>
            <option value="maybe">Maybe</option>
          </select>
        </label>

        <div class="font-body text-text-muted text-ui-sm tracking-ui-wide flex flex-col gap-1.5 uppercase">
          Dietary requirements (optional)
          <div class="normal-case">
            {/* Inline on a narrow panel, where answering should be a tap,
                behind a trigger on a wide one. The panel decides, not the
                window: a narrow panel on a wide screen is still narrow. */}
            <Show
              when={compact()}
              fallback={
                <DietaryPresets
                  value={formPresets()}
                  onChange={setFormPresets}
                  disabled={saving()}
                  label={`Dietary requirements for ${guest.firstName} ${guest.lastName}`}
                />
              }
            >
              <DietaryPresetsInline
                value={formPresets()}
                onChange={setFormPresets}
                disabled={saving()}
                label={`Dietary requirements for ${guest.firstName} ${guest.lastName}`}
              />
            </Show>
          </div>
        </div>

        {/* Free text for whatever the vocabulary has no key for. Always shown
            here rather than behind an "Other" tick: an organiser is copying
            down a reply someone gave on the phone, so the box has to be ready
            for words they are already hearing. */}
        <label class="font-body text-text-muted text-ui-sm tracking-ui-wide flex flex-col gap-1 uppercase">
          Anything else
          <textarea
            class="border-border bg-bg text-text text-ui-base rounded-sm border px-2.5 py-1.5 normal-case"
            rows={2}
            maxlength={500}
            value={formDietary()}
            onInput={(e) => setFormDietary(e.currentTarget.value)}
            disabled={saving()}
          />
        </label>

        <Show when={keeps()}>
          <p id={keepsId} class="font-body text-text-muted text-ui-sm">
            Saving without changing these keeps the dietary requirements already given:{" "}
            {storedDietary}.
          </p>
        </Show>

        {/* Gated on the SAME condition the submit gate and the payload use.
            Gating visibility on the free text alone left a preset-only reply
            attested with no control on screen. Shown only once the answer is
            edited: an unedited one is kept as it was given, and needs no new
            attestation. */}
        <Show
          when={
            dietaryEdited(target) && (formDietary().trim().length > 0 || formPresets().length > 0)
          }
        >
          <div class="flex flex-col gap-1.5">
            <label class="font-body text-text-muted text-ui-sm flex items-start gap-2.5 leading-relaxed normal-case">
              <input
                type="checkbox"
                class="accent-gold mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
                checked={formConsent()}
                onChange={(e) => setFormConsent(e.currentTarget.checked)}
                disabled={saving()}
              />
              <span>{attestationFor(target).text}</span>
            </label>
            {/* A plus-one may never see the invite or the notice it links, so
                the organiser recording their answer is asked to pass on the
                privacy page the line names, which leads to the guests'
                notice. Outside the label, so it is no part of what the box
                attests or of its accessible name; a new tab, so the form
                keeps what was typed. */}
            <Show when={target.plusOne}>
              <p class="font-body text-text-muted text-ui-sm pl-6.5 leading-relaxed">
                Share our privacy notice with them:{" "}
                <a
                  href={`${CIRE_MARKETING_URL}/privacy`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-gold-ink underline underline-offset-2"
                >
                  cireweddings.com/privacy<span class="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            </Show>
          </div>
        </Show>

        <Show when={formError()}>
          <p role="alert" class="text-error text-ui-sm">
            {formError()}
          </p>
        </Show>

        <div class="flex items-center gap-2">
          {/* Both at the default size, which they were not: Cancel was already a
              `<Button>` at `md` and Save was hand-written at `px-3 py-1.5`, so
              the two controls in this one row were different heights. */}
          <Button
            variant="primary"
            type="submit"
            disabled={saving()}
            aria-describedby={keeps() ? keepsId : undefined}
          >
            {saving() ? "Saving…" : "Save reply"}
          </Button>
          <Button variant="quiet" type="button" onClick={closeEditor} disabled={saving()}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  /** The editor form wrapped in a full-width row, opened under the row it edits. */
  function renderEditorRow() {
    const target = edit();
    if (!target) return null;
    const [firstName, ...rest] = target.guestName.split(" ");
    return (
      <tr>
        <td colSpan={props.canEdit ? 5 : 4} class="border-border border-b px-4 py-3">
          {renderEditorForm({ firstName: firstName ?? "", lastName: rest.join(" ") }, target)}
        </td>
      </tr>
    );
  }

  /** The same form as a block, under the guest block it edits. */
  function renderEditorBlock() {
    const target = edit();
    if (!target) return null;
    const [firstName, ...rest] = target.guestName.split(" ");
    return (
      <div class="pt-2">
        {renderEditorForm({ firstName: firstName ?? "", lastName: rest.join(" ") }, target)}
      </div>
    );
  }
}
