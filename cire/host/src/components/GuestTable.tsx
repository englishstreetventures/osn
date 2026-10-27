import Button from "@cire/ui/button";
import { tokeniseQuery, tokensPrefixName } from "@shared/db-utils/search";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { heldWhileClosing, Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { Switch } from "@shared/ui/ui/switch";
import { Table, Td, Th } from "@shared/ui/ui/table";
import Ban from "lucide-solid/icons/ban";
import Copy from "lucide-solid/icons/copy";
import Download from "lucide-solid/icons/download";
import Ellipsis from "lucide-solid/icons/ellipsis";
import RotateCcw from "lucide-solid/icons/rotate-ccw";
import UserCheck from "lucide-solid/icons/user-check";
import UserX from "lucide-solid/icons/user-x";
import {
  createComputed,
  createEffect,
  on,
  createSelector,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
  For,
  createMemo,
  type JSX,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { downloadBlob } from "../lib/download";
import {
  ensureEventsLoaded,
  type EventRow as CachedEventRow,
  eventsAccessor,
} from "../lib/events-store";
import {
  ensureGuestsLoaded,
  guestsAccessor,
  hasCachedGuests,
  invalidateGuests,
  type OrganiserGuestRow,
  peekCachedGuests,
  setCachedGuests,
} from "../lib/guests-store";
import { invalidateHouseholds } from "../lib/households-store";
import { buildInviteMessage, copyToClipboard } from "../lib/invite-message";
import { markHouseholdShared } from "../lib/mark-shared";
import {
  type ConfirmedPlusOne,
  householdPermission,
  isPlusOne,
  placePlusOnesAfterInviters,
  plusOnesRemovedBy,
  type PlusOneScope,
  putPlusOnePermission,
  supportsPlusOnes,
  withPermission,
} from "../lib/plus-one-permission";
import { chromeFoot, scrollToResults } from "../lib/scroll-to-results";
import { IconButton } from "./ActionTip";
import SectionIntro from "./SectionIntro";
import { createCompact, holdUntilReady, ViewBar } from "./ViewBar";

interface FamilyMember {
  /** Identity for `reconcile`: the guest id. */
  key: string;
  guestId: string;
  firstName: string;
  lastName: string;
  events: string[];
  plusOneAllowed?: boolean;
  plusOneOf: string | null;
  email: string | null;
  emailSource: "guest" | "organiser_attested" | null;
  emailOptedOut: boolean;
}

interface FamilyGroup {
  /** Identity for `reconcile`: the household's code, which is what groups it. */
  key: string;
  familyId: string;
  publicId: string;
  familyName: string;
  codeSharedAt: number | null;
  firstOpenedAt: number | null;
  deactivatedAt: number | null;
  members: FamilyMember[];
}

/** The guest rows grouped into households, each plus-one after the guest who
 *  brought them. */
function groupIntoFamilies(rows: readonly OrganiserGuestRow[]): FamilyGroup[] {
  const map = new Map<string, FamilyGroup>();
  for (const guest of rows) {
    let family = map.get(guest.publicId);
    if (!family) {
      family = {
        key: guest.publicId,
        familyId: guest.familyId,
        publicId: guest.publicId,
        familyName: guest.familyName,
        codeSharedAt: guest.codeSharedAt,
        firstOpenedAt: guest.firstOpenedAt,
        deactivatedAt: guest.deactivatedAt,
        members: [],
      };
      map.set(guest.publicId, family);
    }
    family.members.push({
      // A row always carries its id; the fallback only keeps two id-less rows
      // from being taken for one.
      key: guest.guestId ?? `${guest.publicId}#${family.members.length}`,
      guestId: guest.guestId,
      firstName: guest.firstName,
      lastName: guest.lastName,
      events: guest.events,
      plusOneAllowed: guest.plusOneAllowed,
      plusOneOf: guest.plusOneOf ?? null,
      email: guest.email ?? null,
      emailSource: guest.emailSource ?? null,
      emailOptedOut: guest.emailOptedOut === true,
    });
  }
  for (const family of map.values()) family.members = placePlusOnesAfterInviters(family.members);
  return Array.from(map.values());
}

/**
 * The guest's address under their name, saying who gave it, and — when a
 * guest withdrew it — that guest comms will not mail it. In words, not colour
 * alone.
 */
function GuestEmailLine(props: { member: FamilyMember }) {
  return (
    <Show when={props.member.email}>
      {(email) => (
        <span class="text-text-muted text-ui-sm mt-0.5 block break-all">
          {email()}
          <span class="whitespace-nowrap">
            {" · "}
            {props.member.emailSource === "guest" ? "added by the guest" : "added by a host"}
          </span>
          <Show when={props.member.emailOptedOut}>
            <span class="text-warn whitespace-nowrap">
              {" · "}
              opted out: no wedding email goes here
            </span>
          </Show>
        </span>
      )}
    </Show>
  );
}

const fullName = (person: { firstName: string; lastName: string }) =>
  `${person.firstName} ${person.lastName}`.trim();

/** One plus-one a confirmation names, and whose they are. Carries the first
 *  and last name exactly as the guest list served them: that is what the
 *  removal sends back for the API to check against. */
interface NamedPlusOne extends ConfirmedPlusOne {
  name: string;
  inviterName: string;
}

/** A turn-off that would delete named plus-ones, waiting on the organiser. */
interface PendingRemoval {
  scope: PlusOneScope;
  /** The household, for the household-wide wording. */
  familyName: string;
  plusOnes: NamedPlusOne[];
  /** Asked again because the household changed its plus-ones meanwhile. */
  changed: boolean;
}

/** Friendly date for the "Opened" tooltip (e.g. "19 Jun 2026"). */
function formatOpenedDate(epochMs: number): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(epochMs));
}

// "Opened" is a reliable, server-only signal: a guest actually claimed/opened
// the invite with the family's current code (host-preview claims excluded). No
// optimistic flip — unlike "Sent", it never comes from a local action, so it's
// a pure function of the server row (kept at module scope).
const isOpened = (family: FamilyGroup) => family.firstOpenedAt !== null;

// A family whose code the organiser cut off (withdrawn invite). Pure function of
// the server row plus the local optimistic override (see `deactivatedNow` /
// `reactivatedNow` below), so the row mutes + relabels immediately on toggle.

/** Debounce window (ms) before a typed search prefix re-filters the roster —
 *  a wedding on Crimson can hold up to 1000 guests (`TIER_GUEST_CAP` in
 *  cire-api's `services/tiers.ts`), and
 *  without this every keystroke re-tokenises + re-scans the whole roster
 *  synchronously on the main thread. */
const SEARCH_DEBOUNCE_MS = 200;

/** True when `family` itself (name or code) matches the query — as opposed to
 *  one of its members. Shared by the roster-level filter and each row's own
 *  member-visibility check so the two agree on what counts as a household
 *  match. */
function householdMatches(family: FamilyGroup, tokens: string[], lowerQuery: string): boolean {
  return (
    tokensPrefixName(family.familyName, tokens) ||
    family.publicId.toLowerCase().includes(lowerQuery)
  );
}

interface GuestTableProps {
  weddingId: string;
  /** True when the signed-in organiser OWNS this wedding. Claim codes are the
   *  guest credential, so cutting one off (deactivate/reactivate) is
   *  owner-only, and so are the CSV downloads — the API gates them with
   *  weddingOwner(); this hides those buttons. */
  canManage: boolean;
  /** Owner or editor? Who may bring a plus-one, and marking a household's code
   *  sent when its message is copied, are editor writes (the API gates them
   *  with weddingEditor()); anyone else sees each guest's switch read-only, no
   *  household controls, and copies without marking. Absent reads as
   *  read-only. */
  canEdit?: boolean;
  /** Display name of the wedding — used in the copied invite message. */
  weddingName: string;
  /** URL slug of the wedding — the copied invite message puts it in the query
   *  of the fixed guest invitation route. */
  weddingSlug: string;
  /** The line pointing at the other places that shape the invite message, shown
   *  under the introduction. */
  inviteMessageLinks?: JSX.Element;
  /** Drawn alone, outside the module shell: whether to draw the narrow layout.
   *  Inside the shell the panel's width decides. */
  compact?: boolean;
}

/**
 * The narrowest panel the households' tables fit: the fixed Plus-one (7rem)
 * and Code (11rem) columns, Events at a third, and room for a 12rem Guest column —
 * about 46rem. Without the Plus-one column, 40rem. Narrower, the rows stack.
 */
const TABLE_MIN_REM = { plusOnes: 46, plain: 40 } as const;

/** Where a focused control in a household's rows must stay below: the top bar,
 *  the view bar, the head strip when there is one, and the household's bar,
 *  and a rem more, because a switch's focusable input sits inside its label,
 *  below the track's top edge. */
const ROWS_SCROLL_MARGIN =
  "[&_:is(button,input,a,[tabindex])]:scroll-mt-[calc(var(--chrome-h)+var(--bar-h,0px)+var(--heads-h,0px)+var(--hh-bar-h)+1rem)]";

/** One row of a household's bar: its name and state, then what can be done. */
const HOUSEHOLD_BAR =
  "border-border bg-surface sticky top-[calc(var(--chrome-h)+var(--bar-h,0px)+var(--heads-h,0px))] z-5 flex h-(--hh-bar-h) items-center gap-3 border-b px-4 whitespace-nowrap";

export default function GuestTable(props: GuestTableProps) {
  const { authFetch } = useAuth();
  // Guest rows live in a module-scoped, weddingId-keyed cache (`guests-store`,
  // the fetch-lift sibling of `events-store`) so this fetch fires once per
  // wedding and is reused when the module shell unmounts/remounts us on a
  // Guests ↔ Schedule switch. An import apply invalidates the entry.
  const guests = () => guestsAccessor(props.weddingId)() ?? [];
  // The event id→name chip map reads the SHARED events cache instead of a second
  // `/events` fetch (the same fetch-lift pattern as the guest cache above): a
  // Schedule visit already populated it, and if not we `ensureEventsLoaded` it
  // once below.
  const eventNameById = createMemo(
    () => new Map((eventsAccessor(props.weddingId)() ?? []).map((e) => [e.id, e.name])),
  );
  // Optional host override for the first line of the copied invite message. Read
  // from the same invite-customisation endpoint the Invite builder writes; `null`
  // ⇒ buildInviteMessage falls back to its default prose.
  const [inviteMessage, setInviteMessage] = createSignal<string | null>(null);
  // Whether that read has settled — answered, failed or thrown. Copy waits for
  // it: on a remount the cached rows paint at once, and a copy before the read
  // lands would send the default first line in place of the host's own.
  const [messageSettled, setMessageSettled] = createSignal(false);
  // Skip the skeleton on a cache hit — a remount already has rows to paint.
  const [loading, setLoading] = createSignal(!hasCachedGuests(props.weddingId));
  const [error, setError] = createSignal<string | null>(null);
  // Optimistic "Sent" state keyed by family public_id — flips the instant a
  // copy succeeds, so the indicator updates without a reload while the
  // best-effort mark-shared POST settles in the background.
  const [sharedNow, setSharedNow] = createSignal<Set<string>>(new Set());
  // Which CSV export is in flight (both buttons share the guard so only one
  // download runs at a time).
  const [exporting, setExporting] = createSignal<"rsvps" | "guests" | null>(null);
  // Optimistic deactivation overrides keyed by family id, applied over the
  // server's `deactivatedAt` so a confirmed toggle mutes/relabels the row at once
  // while the POST settles. A family id can appear in at most one set; clearing
  // the other on each toggle keeps them mutually exclusive.
  const [deactivatedNow, setDeactivatedNow] = createSignal<Set<string>>(new Set());
  const [reactivatedNow, setReactivatedNow] = createSignal<Set<string>>(new Set());
  // Per-family in-flight + confirm state for the deactivate/reactivate toggle.
  const [togglingId, setTogglingId] = createSignal<string | null>(null);
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);

  // Households live in a store that each new set of rows is RECONCILED into,
  // keyed by household code and guest id, rather than rebuilt: a household or
  // guest that is still there keeps its object, so `<For>` keeps its row and
  // the DOM inside it. Rebuilding would remount every row on any change to the
  // cached rows — a plus-one switch the organiser just pressed would leave the
  // page, and focus with it.
  const [families, setFamilies] = createStore<FamilyGroup[]>([]);
  createComputed(() => setFamilies(reconcile(groupIntoFamilies(guests()), { key: "key" })));

  // Whether the API serving this list knows about plus-ones (see
  // `supportsPlusOnes`), and so whether the column shows at all.
  const plusOnesShown = createMemo(() => supportsPlusOnes(guests()));
  const canEdit = () => props.canEdit === true;
  // The one plus-one write — or the reload that goes with one — in flight, by
  // what it covers: `guest:<id>`, `family:<id>`. One at a time across the
  // table, so a reload never lands over a write that finished after it read,
  // and a household write never races one of its members'. A control asked
  // for meanwhile does nothing, and a switch stays as it was.
  const [plusOneBusy, setPlusOneBusy] = createSignal<string | null>(null);
  // Which controls show the write as theirs. A selector, so a write re-renders
  // only the switches it covers rather than every row in the roster; the lock
  // itself is the check in `exclusively` and `requestPermission`.
  const isBusy = createSelector(plusOneBusy);
  const [pendingRemoval, setPendingRemoval] = createSignal<PendingRemoval | null>(null);
  // What the dialog renders while it fades out: its body names people.
  const shownRemoval = heldWhileClosing(pendingRemoval);
  const removalTitleId = `plus-one-removal-title-${createUniqueId()}`;
  const removalBodyId = `plus-one-removal-body-${createUniqueId()}`;

  // Free-text search over the already-loaded roster — the whole list is
  // fetched up front for this wedding (bounded by guest-list size, not
  // paginated), so this filters client-side rather than round-tripping a
  // `/guests?q=` search. Matches a household name (any member visible once it
  // does), a member's full name (word-prefix, via the same tokeniser the rest
  // of the monorepo's name search uses), or the family code verbatim.
  //
  // `searchInput` is the raw, un-debounced box value (so typing feels
  // instant); `search` is what actually drives filtering, debounced so a
  // 1000-guest roster (the top of cire-api's plan tiers) isn't re-tokenised
  // and re-scanned on every keystroke.
  const [searchInput, setSearchInput] = createSignal("");
  const [search, setSearch] = createSignal("");
  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchDebounceTimer));

  function handleSearchInput(value: string) {
    setSearchInput(value);
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => setSearch(value), SEARCH_DEBOUNCE_MS);
  }

  // Membership only — which households have a match. Returns the ORIGINAL
  // `family` references from `families` unchanged (never a copy), so a
  // household whose visibility doesn't change between two searches keeps its
  // identity and `<For>` reuses its row instead of tearing it down and
  // remounting it. Which of a matched household's members are actually shown
  // is a separate, per-row computation below (`visibleMembers`).
  const visibleFamilies = createMemo(() => {
    const query = search().trim();
    if (!query) return families;
    const tokens = tokeniseQuery(query);
    const lowerQuery = query.toLowerCase();
    return families.filter(
      (family) =>
        householdMatches(family, tokens, lowerQuery) ||
        family.members.some((m) => tokensPrefixName(`${m.firstName} ${m.lastName}`, tokens)),
    );
  });

  const isShared = (family: FamilyGroup) =>
    family.codeSharedAt !== null || sharedNow().has(family.publicId);

  /** Resolve a family's deactivation, blending the server row with the local
   *  optimistic override so a just-toggled row reflects the new state at once. */
  const isDeactivated = (family: FamilyGroup) => {
    if (reactivatedNow().has(family.familyId)) return false;
    if (deactivatedNow().has(family.familyId)) return true;
    return family.deactivatedAt !== null;
  };

  /** The guest list, fresh from the API — the fetcher behind the guest cache. */
  async function fetchGuests(): Promise<OrganiserGuestRow[]> {
    const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/guests")));
    if (res.status === 401) {
      redirectToLogin();
      throw new Error("unauthenticated");
    }
    if (!res.ok) throw new Error("Failed to load");
    return (await res.json()) as OrganiserGuestRow[];
  }

  onMount(async () => {
    try {
      // Guests + events both flow through their shared caches (one fetch each per
      // wedding, deduped across module switches). Events are needed only
      // for the chip map; a Schedule visit may already have them. The invite
      // message is a light per-mount read (no store — it's tiny + non-essential).
      const [, , inviteRes] = await Promise.all([
        ensureGuestsLoaded(props.weddingId, fetchGuests),
        ensureEventsLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/events")));
          if (res.status === 401) {
            redirectToLogin();
            throw new Error("unauthenticated");
          }
          if (!res.ok) throw new Error("Failed to load");
          return (await res.json()) as CachedEventRow[];
        }),
        authFetch(apiUrl(weddingPath(props.weddingId, "/invite"))),
      ]);
      if (inviteRes.status === 401) return redirectToLogin();
      // The custom invite message is non-essential to the table — if it fails to
      // load, fall back to the default prose rather than breaking the guest list.
      if (inviteRes.ok) {
        const invite = (await inviteRes.json()) as { inviteMessage: string | null };
        setInviteMessage(invite.inviteMessage);
      }
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load guest list. Is the API running?");
    } finally {
      setMessageSettled(true);
      setLoading(false);
    }
  });

  /** Best-effort: tell the API the family's code was just shared. Never blocks
   *  or surfaces an error to the organiser — the copy already succeeded. The
   *  API records it for an owner or an editor, so a viewer's copy marks
   *  nothing: no request that can only be refused, and no "Sent" the server
   *  never saw. */
  function markShared(family: FamilyGroup) {
    if (!canEdit()) return;
    // The flip stays if the POST fails: a missed mark only under-counts the
    // remint warning.
    setSharedNow((prev) => new Set(prev).add(family.publicId));
    void markHouseholdShared(authFetch, props.weddingId, family.familyId);
  }

  /**
   * Deactivate (cut off a withdrawn invite) or reactivate a family. Confirm-gated
   * for the destructive deactivate direction; reactivate fires directly. Flips the
   * optimistic override on success, surfaces an inline error + toast on failure,
   * and redirects on 401 — matching the mark-shared / copy patterns. The family's
   * guests/RSVPs are never deleted, so reactivating restores the code's data.
   */
  async function toggleDeactivated(family: FamilyGroup, deactivate: boolean) {
    if (togglingId() === family.familyId) return;
    setTogglingId(family.familyId);
    setError(null);
    const action = deactivate ? "deactivate" : "reactivate";
    try {
      const res = await authFetch(
        apiUrl(
          weddingPath(
            props.weddingId,
            `/families/${encodeURIComponent(family.familyId)}/${action}`,
          ),
        ),
        { method: "POST" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setError(
          deactivate
            ? `Could not deactivate ${family.familyName}. Please try again.`
            : `Could not reactivate ${family.familyName}. Please try again.`,
        );
        toast.error(
          deactivate ? "Could not deactivate household" : "Could not reactivate household",
        );
        return;
      }
      // Flip the optimistic override (mutually exclusive sets).
      if (deactivate) {
        setDeactivatedNow((prev) => new Set(prev).add(family.familyId));
        setReactivatedNow((prev) => {
          const next = new Set(prev);
          next.delete(family.familyId);
          return next;
        });
        toast.success(`Deactivated ${family.familyName} — code disabled`);
      } else {
        setReactivatedNow((prev) => new Set(prev).add(family.familyId));
        setDeactivatedNow((prev) => {
          const next = new Set(prev);
          next.delete(family.familyId);
          return next;
        });
        toast.success(`Reactivated ${family.familyName} — code enabled`);
      }
      setConfirmingId(null);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not update the household. Is the API running?");
    } finally {
      setTogglingId(null);
    }
  }

  /**
   * Download one of the wedding's CSV exports — the RSVP grid (`rsvps.csv`) or
   * the guest roster (`guests.csv`). Both are built (and formula-sanitised)
   * server-side; the response Blob is handed to the shared download helper.
   * authFetch attaches the OSN access token — the endpoints are gated by
   * `weddingOwner()`, so only an owner is offered the buttons.
   */
  async function exportCsv(kind: "rsvps" | "guests") {
    if (exporting()) return;
    setExporting(kind);
    const label = kind === "rsvps" ? "RSVP" : "Guest list";
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, `/${kind}.csv`)));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      downloadBlob(`cire-${kind}-${props.weddingSlug}.csv`, blob);
      toast.success(`${label} export downloaded`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error(`${label} export failed. Try again.`);
    } finally {
      setExporting(null);
    }
  }

  async function copyMessage(family: FamilyGroup) {
    const message = buildInviteMessage(
      props.weddingName,
      family.publicId,
      props.weddingSlug,
      inviteMessage(),
    );
    const ok = await copyToClipboard(message);
    if (ok) {
      toast.success(`Copied ${family.familyName}'s invite message`);
      markShared(family);
    } else {
      toast.error("Couldn't copy automatically. Select and copy the code manually.");
    }
  }

  // ── Plus-one permission ─────────────────────────────────────────────────
  // Contract: `wiki/cire/cire-plus-ones.md`. Turning permission off where a
  // plus-one is named deletes them with their replies, outside the change
  // history, so it is never sent without the organiser having been shown who
  // and said yes. The write carries the plus-ones the confirmation showed, and
  // the API refuses it if the household has changed them since.

  /** The plus-ones `scope` would delete, named with whose they are. Built from
   *  the whole list, never the search-filtered rows. */
  function namePlusOnes(rows: readonly OrganiserGuestRow[], scope: PlusOneScope): NamedPlusOne[] {
    const byId = new Map(rows.map((row) => [row.guestId, row]));
    return plusOnesRemovedBy(rows, scope).map((plusOne) => {
      const inviter = plusOne.plusOneOf ? byId.get(plusOne.plusOneOf) : undefined;
      return {
        guestId: plusOne.guestId,
        firstName: plusOne.firstName,
        lastName: plusOne.lastName,
        name: fullName(plusOne),
        inviterName: inviter ? fullName(inviter) : "",
      };
    });
  }

  /** The household a scope sits in, for the wording. */
  function familyNameOf(rows: readonly OrganiserGuestRow[], scope: PlusOneScope): string {
    const row =
      scope.kind === "guest"
        ? rows.find((r) => r.guestId === scope.guestId)
        : rows.find((r) => r.familyId === scope.familyId);
    return row?.familyName ?? "";
  }

  const busyKey = (scope: PlusOneScope) =>
    scope.kind === "guest" ? `guest:${scope.guestId}` : `family:${scope.familyId}`;

  /** Run one plus-one write at a time; a second asked for meanwhile is dropped. */
  async function exclusively(scope: PlusOneScope, work: () => Promise<void>) {
    if (plusOneBusy() !== null) return;
    setPlusOneBusy(busyKey(scope));
    try {
      await work();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error("Could not change the plus-one setting. Try again.");
    } finally {
      setPlusOneBusy(null);
    }
  }

  /** Read the guest list again. `null` when it could not be read — the error
   *  is then on screen, in place of a list that would read as empty. */
  async function reloadGuests(): Promise<OrganiserGuestRow[] | null> {
    invalidateGuests(props.weddingId);
    try {
      const loaded = await ensureGuestsLoaded(props.weddingId, fetchGuests);
      const rows = peekCachedGuests(props.weddingId);
      if (!loaded || rows == null) throw new Error("guest list unavailable");
      return rows;
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return null;
      }
      setError("Could not reload the guest list. Refresh to try again.");
      return null;
    }
  }

  /** Ask for the removal, naming everyone it deletes. */
  function askToRemove(rows: readonly OrganiserGuestRow[], scope: PlusOneScope, changed: boolean) {
    setPendingRemoval({
      scope,
      familyName: familyNameOf(rows, scope),
      plusOnes: namePlusOnes(rows, scope),
      changed,
    });
  }

  /**
   * Send one permission write and apply its answer. `remove` is the plus-ones
   * the organiser confirmed, as the confirmation captured them; `null` for a
   * write that confirms nobody.
   */
  async function sendPermission(
    scope: PlusOneScope,
    allowed: boolean,
    remove: readonly NamedPlusOne[] | null,
  ): Promise<void> {
    const familyName = familyNameOf(guests(), scope);
    const answer = await putPlusOnePermission(authFetch, props.weddingId, scope, allowed, remove);
    switch (answer.kind) {
      case "unauthenticated":
        redirectToLogin();
        return;
      case "saved": {
        const rows = peekCachedGuests(props.weddingId);
        if (rows) setCachedGuests(props.weddingId, withPermission(rows, scope, allowed));
        // A removal changes the household's guest count.
        if (answer.removed > 0) invalidateHouseholds(props.weddingId);
        // Fewer than confirmed is not an error: the household took one back
        // meanwhile, and the API deletes only people on the confirmed list.
        if (answer.removed > 0) {
          toast.success(
            answer.removed === 1 && remove?.length === 1
              ? `Removed ${remove[0]!.name}`
              : `Removed ${answer.removed} ${answer.removed === 1 ? "plus-one" : "plus-ones"}`,
          );
        }
        if (scope.kind === "household") {
          toast.success(
            allowed
              ? `Everyone in ${familyName} may bring a plus-one`
              : `No one in ${familyName} may bring a plus-one`,
          );
        }
        return;
      }
      case "named": {
        // A plus-one in scope was not among those confirmed: named after this
        // list was read, or swapped or renamed since the confirmation opened.
        // Show who is there now, and ask.
        const fresh = await reloadGuests();
        if (!fresh) return;
        if (plusOnesRemovedBy(fresh, scope).length > 0) askToRemove(fresh, scope, true);
        else toast.error("The guest list changed. Try again.");
        return;
      }
      case "refused":
        if (answer.status === 404) {
          await reloadGuests();
          toast.error("That guest is no longer on the list.");
        } else if (answer.status === 403) {
          toast.error("Only owners and editors can change plus-ones.");
        } else {
          toast.error("Could not change the plus-one setting. Try again.");
        }
        return;
    }
  }

  /** A switch or household button asked for `allowed` on `scope`. */
  function requestPermission(scope: PlusOneScope, allowed: boolean) {
    if (!canEdit() || plusOneBusy() !== null) return;
    if (!allowed && plusOnesRemovedBy(guests(), scope).length > 0) {
      // Opened once the gesture has finished, not inside it: a switch pressed
      // with a pointer asks for the change before it takes focus, and the
      // dialog returns focus to whatever held it when it opened.
      queueMicrotask(() => askToRemove(guests(), scope, false));
      return;
    }
    void exclusively(scope, () => sendPermission(scope, allowed, null));
  }

  /**
   * The organiser said yes to removing the plus-ones the dialog named. The
   * write carries the dialog's own snapshot of them — never the list as it is
   * now, which would confirm whoever the household has named since. If they
   * have changed, the API refuses and the organiser is asked again.
   */
  function confirmRemoval() {
    const pending = pendingRemoval();
    if (!pending) return;
    setPendingRemoval(null);
    void exclusively(pending.scope, () => sendPermission(pending.scope, false, pending.plusOnes));
  }

  const hasGuests = () => families.length > 0;

  // The narrow layout, from the width the module panel has (or, drawn alone,
  // from the `compact` prop). One variant is drawn, never both.
  const layout = createCompact(
    () => (plusOnesShown() ? TABLE_MIN_REM.plusOnes : TABLE_MIN_REM.plain),
    () => props.compact ?? false,
  );
  const compact = layout.compact;

  // Hold the module panel open until the list is in, so a sub-tab change made
  // deep in another list does not clamp the page meanwhile.
  const ready = holdUntilReady();
  createEffect(() => {
    if (!loading()) ready();
  });

  // A search redraws the list once the debounce settles. If the host had
  // scrolled into it, the page brings the list's top back to the foot of the
  // stuck chrome; otherwise nothing moves, and focus stays in the field.
  let results: HTMLDivElement | undefined;
  createEffect(
    on(
      search,
      () => {
        if (results?.isConnected) scrollToResults(results, chromeFoot(results));
      },
      { defer: true },
    ),
  );

  // The narrow layout's Deactivate asks in a dialog: a menu closes as soon as
  // an item is chosen, so the wide bar's inline "Disable this code?" has
  // nowhere to live.
  const [confirmingDialog, setConfirmingDialog] = createSignal<FamilyGroup | null>(null);
  const shownConfirm = heldWhileClosing(confirmingDialog);
  const confirmTitleId = `deactivate-title-${createUniqueId()}`;

  const countLine = () =>
    `${guests().length} ${guests().length === 1 ? "guest" : "guests"} across ${families.length} ${
      families.length === 1 ? "household" : "households"
    }`;

  /** The household's state, in a word: deactivated, else opened, else sent. */
  const householdBadge = (family: FamilyGroup) => (
    <>
      <Show when={isDeactivated(family)}>
        <span
          class="font-body border-error/40 text-error text-ui-xs tracking-ui-widest shrink-0 rounded-sm border px-1.5 py-0.5 uppercase not-italic"
          title="Deactivated — this household's code no longer opens the invite. Reactivate to restore it."
        >
          {/* The whole state on a wide bar; one word where the bar is narrow,
              the rest kept for assistive technology. */}
          <Show when={compact()} fallback="Deactivated — code disabled">
            Deactivated<span class="sr-only"> — code disabled</span>
          </Show>
        </span>
      </Show>
      {/* Status badges are suppressed while deactivated — the "Deactivated"
          label is the only relevant state then. "Opened" (a real guest claim)
          otherwise takes precedence over the copy-only "Sent". */}
      <Show when={!isDeactivated(family)}>
        <Show
          when={isOpened(family)}
          fallback={
            <Show when={isShared(family)}>
              <span
                class="font-body text-gold/80 border-gold/30 text-ui-xs tracking-ui-widest shrink-0 rounded-sm border px-1.5 py-0.5 uppercase not-italic"
                title="Sent — you copied this family's invite message"
              >
                Sent
              </span>
            </Show>
          }
        >
          <span
            class="font-body bg-gold text-bg text-ui-xs tracking-ui-widest shrink-0 rounded-sm px-1.5 py-0.5 uppercase not-italic"
            title={`Opened — a guest opened this invite (code used) on ${formatOpenedDate(
              family.firstOpenedAt!,
            )}`}
          >
            Opened
          </span>
        </Show>
      </Show>
    </>
  );

  /** The four columns, shared by every household's table and the head strip,
   *  so they line up. They follow whether the Plus-one column is shown. */
  const colgroup = () => (
    <colgroup>
      <col />
      <col class="w-1/3" />
      <Show when={plusOnesShown()}>
        <col class="w-28" />
      </Show>
      <col class="w-44" />
    </colgroup>
  );

  const HEADS = () =>
    plusOnesShown() ? ["Guest", "Events", "Plus-one", "Code"] : ["Guest", "Events", "Code"];

  /**
   * The wide bar's actions: four icons, each named and with its name as a
   * tooltip — Allow everyone, Allow no one, Copy message, Deactivate (or
   * Reactivate). Deactivate's confirmation takes their place in the same
   * row, so the bar never grows.
   */
  function wideActions(
    family: FamilyGroup,
    permission: () => { allowed: number; total: number },
    householdScope: PlusOneScope,
    plusOneControls: () => boolean,
  ) {
    return (
      <div class="flex shrink-0 items-center gap-1">
        <Show
          when={props.canManage && !isDeactivated(family) && confirmingId() === family.familyId}
          fallback={
            <>
              {/* Editors only: these write. A viewer reads each guest's
                  switch instead. `aria-disabled`, never `disabled`: the button
                  keeps focus through its own write and stays reachable when it
                  would change nothing. */}
              <Show when={plusOneControls()}>
                <fieldset class="m-0 flex min-w-0 items-center gap-1 border-0 p-0">
                  <legend class="sr-only">Plus-ones for the {family.familyName} household</legend>
                  <span class="font-body text-text-muted text-ui-xs tracking-ui-wide mr-1 shrink-0">
                    Plus-ones: {permission().allowed} of {permission().total}
                  </span>
                  <IconButton
                    variant="quiet"
                    size="icon"
                    label="Allow everyone"
                    aria-disabled={permission().allowed === permission().total}
                    aria-busy={isBusy(busyKey(householdScope)) ? "true" : undefined}
                    onClick={() => requestPermission(householdScope, true)}
                  >
                    <UserCheck aria-hidden="true" strokeWidth={1.75} class="size-4" />
                  </IconButton>
                  <IconButton
                    variant="quiet"
                    size="icon"
                    label="Allow no one"
                    aria-disabled={permission().allowed === 0}
                    aria-busy={isBusy(busyKey(householdScope)) ? "true" : undefined}
                    onClick={() => requestPermission(householdScope, false)}
                  >
                    <UserX aria-hidden="true" strokeWidth={1.75} class="size-4" />
                  </IconButton>
                </fieldset>
              </Show>
              <IconButton
                variant="quiet"
                size="icon"
                label="Copy message"
                disabled={!messageSettled()}
                onClick={() => void copyMessage(family)}
              >
                <Copy aria-hidden="true" strokeWidth={1.75} class="size-4" />
              </IconButton>
              {/* Deactivate is confirm-gated (cuts off a live code);
                  Reactivate is a direct restore. Owner-only — code management
                  sits above editor writes. */}
              <Show when={props.canManage}>
                <Show
                  when={isDeactivated(family)}
                  fallback={
                    <IconButton
                      variant="quietDanger"
                      size="icon"
                      label="Deactivate"
                      onClick={() => setConfirmingId(family.familyId)}
                      disabled={togglingId() === family.familyId}
                    >
                      <Ban aria-hidden="true" strokeWidth={1.75} class="size-4" />
                    </IconButton>
                  }
                >
                  <IconButton
                    variant="quiet"
                    size="icon"
                    label={togglingId() === family.familyId ? "Reactivating…" : "Reactivate"}
                    onClick={() => void toggleDeactivated(family, false)}
                    disabled={togglingId() === family.familyId}
                  >
                    <RotateCcw aria-hidden="true" strokeWidth={1.75} class="size-4" />
                  </IconButton>
                </Show>
              </Show>
            </>
          }
        >
          <span class="font-body text-text-muted text-ui-xs tracking-ui-wide">
            Disable this code?
          </span>
          <button
            type="button"
            onClick={() => void toggleDeactivated(family, true)}
            disabled={togglingId() === family.familyId}
            class="border-error bg-error font-body text-bg text-ui-xs tracking-ui-wider rounded-sm border px-2.5 py-1 uppercase transition hover:opacity-90 disabled:opacity-40"
          >
            {togglingId() === family.familyId ? "Deactivating…" : "Confirm"}
          </button>
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={() => setConfirmingId(null)}
            disabled={togglingId() === family.familyId}
          >
            Cancel
          </Button>
        </Show>
      </div>
    );
  }

  /** The narrow bar's actions: the same, in one "⋯" menu. */
  function narrowActions(
    family: FamilyGroup,
    permission: () => { allowed: number; total: number },
    householdScope: PlusOneScope,
    plusOneControls: () => boolean,
  ) {
    return (
      <DropdownMenu placement="bottom-end" gutter={4}>
        <DropdownMenuTrigger
          as={Button}
          variant="quiet"
          size="icon"
          aria-label={`Actions for ${family.familyName}`}
          class="shrink-0"
        >
          <Ellipsis aria-hidden="true" strokeWidth={1.75} class="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="min-w-48">
          <Show when={plusOneControls()}>
            <DropdownMenuItem
              disabled={permission().allowed === permission().total}
              onSelect={() => requestPermission(householdScope, true)}
            >
              Allow everyone a plus-one
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={permission().allowed === 0}
              onSelect={() => requestPermission(householdScope, false)}
            >
              Allow no one a plus-one
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </Show>
          <DropdownMenuItem disabled={!messageSettled()} onSelect={() => void copyMessage(family)}>
            Copy message
          </DropdownMenuItem>
          <Show when={props.canManage}>
            <Show
              when={isDeactivated(family)}
              fallback={
                <DropdownMenuItem
                  disabled={togglingId() === family.familyId}
                  onSelect={() => setConfirmingDialog(family)}
                >
                  Deactivate
                </DropdownMenuItem>
              }
            >
              <DropdownMenuItem
                disabled={togglingId() === family.familyId}
                onSelect={() => void toggleDeactivated(family, false)}
              >
                Reactivate
              </DropdownMenuItem>
            </Show>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      class="flex flex-col gap-8"
      // Whether a head strip (its row and its hairline) sits between the view
      // bar and each household's bar: the households' bars stick below it.
      style={{ "--heads-h": compact() ? "0px" : "calc(var(--head-strip-h) + 1px)" }}
    >
      {/* The pointer to where the message is written sits with the intro, not
          a whole section gap below it. */}
      <div class="flex flex-col gap-3">
        <SectionIntro
          eyebrow="Guest list"
          title="Households, invites & RSVPs"
          actions={
            <Show when={props.canManage && !loading() && !error() && hasGuests()}>
              <IconButton
                variant="outline"
                size="icon"
                label={exporting() === "guests" ? "Exporting guests…" : "Download guests (CSV)"}
                onClick={() => void exportCsv("guests")}
                disabled={exporting() !== null}
              >
                <Download aria-hidden="true" strokeWidth={1.75} class="size-4" />
              </IconButton>
              <IconButton
                variant="outline"
                size="icon"
                label={exporting() === "rsvps" ? "Exporting RSVPs…" : "Download RSVPs (CSV)"}
                onClick={() => void exportCsv("rsvps")}
                disabled={exporting() !== null}
              >
                <Download aria-hidden="true" strokeWidth={1.75} class="size-4" />
              </IconButton>
            </Show>
          }
        />
        {props.inviteMessageLinks}
      </div>

      <Show when={loading()}>
        <ViewBar slot="end">
          <div class="bg-surface/60 h-7 w-64 max-w-full min-w-0 animate-pulse rounded-sm" />
        </ViewBar>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3, 4, 5]}>
            {() => <div class="bg-surface h-13 animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <Notice tone="danger">{error()}</Notice>
      </Show>

      <Show when={!loading() && !error() && !hasGuests()}>
        <EmptyState
          title="No guests yet"
          description="Head to Edit to build the list — add households by hand, or upload a guests sheet. Each household gets its own code and invite message to share."
        />
      </Show>

      <Show when={!loading() && !error() && hasGuests() && layout.known()}>
        {/* The count and the search, lent to the view bar's first row. On a
            narrow panel the count stays here, under the bar. */}
        <ViewBar slot="end">
          <Show when={!compact()}>
            <p class="font-body text-text-muted text-ui-sm truncate">{countLine()}</p>
          </Show>
          <Field
            label="Search guests"
            labelHidden
            class={compact() ? "min-w-0 flex-1" : "w-64 shrink-0"}
          >
            {(field) => (
              <Input
                {...field}
                type="search"
                size="sm"
                value={searchInput()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
                placeholder={compact() ? "Search guests…" : "Search by name, household or code…"}
              />
            )}
          </Field>
        </ViewBar>
        <Show when={compact()}>
          <p class="font-body text-text-muted text-ui-sm">{countLine()}</p>
        </Show>

        <div ref={results}>
          <Show when={visibleFamilies().length === 0}>
            <p class="font-body text-text-muted text-ui-sm italic">
              No guests match “{search().trim()}”.
            </p>
          </Show>

          <Show when={visibleFamilies().length > 0}>
            <div class="border-border flex flex-col rounded-sm border">
              {/* The column heads, once for the whole list, stuck under the
                  view bar. A table of its own with the households' columns, so
                  it lines up with every one of them; hidden from assistive
                  technology, which reads each household table's own heads. */}
              <Show when={!compact()}>
                <div
                  aria-hidden="true"
                  data-head-strip
                  class="border-border bg-bg sticky top-[calc(var(--chrome-h)+var(--bar-h,0px))] z-10 border-b"
                >
                  <table class="w-full table-fixed border-separate border-spacing-0 text-left">
                    {colgroup()}
                    <thead>
                      <tr>
                        <For each={HEADS()}>
                          {(name) => (
                            <th class="font-body text-gold-ink text-ui-xs tracking-ui-wider h-(--head-strip-h) px-4 py-0 align-middle font-normal whitespace-nowrap uppercase">
                              {name}
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                  </table>
                </div>
              </Show>
              <For each={visibleFamilies()}>
                {(family) => {
                  // Which of this household's members to show — reactive on
                  // `search()` and the household's own members, so a keystroke
                  // that leaves this household's own visibility unchanged (see
                  // `visibleFamilies` above) still updates its member rows
                  // without the outer `<For>` remounting the whole household.
                  const visibleMembers = createMemo(() => {
                    const query = search().trim();
                    if (!query) return family.members;
                    const tokens = tokeniseQuery(query);
                    if (householdMatches(family, tokens, query.toLowerCase()))
                      return family.members;
                    return family.members.filter((m) =>
                      tokensPrefixName(`${m.firstName} ${m.lastName}`, tokens),
                    );
                  });
                  // Counted over every member, whatever the search shows.
                  const permission = createMemo(() => householdPermission(family.members));
                  const householdScope: PlusOneScope = {
                    kind: "household",
                    familyId: family.familyId,
                  };
                  const inviterName = (member: FamilyMember) => {
                    const inviter = family.members.find((m) => m.guestId === member.plusOneOf);
                    return inviter ? fullName(inviter) : "";
                  };
                  const nameId = `household-${createUniqueId()}`;
                  const plusOneControls = () =>
                    plusOnesShown() && canEdit() && permission().total > 0;
                  const plusOneSwitch = (member: FamilyMember, labelHidden: boolean) => (
                    <Switch
                      checked={member.plusOneAllowed === true}
                      label={labelHidden ? `${fullName(member)} may bring a plus-one` : "Plus-one"}
                      labelHidden={labelHidden}
                      aria-label={
                        labelHidden ? undefined : `${fullName(member)} may bring a plus-one`
                      }
                      readOnly={!canEdit()}
                      busy={isBusy(`guest:${member.guestId}`) || isBusy(busyKey(householdScope))}
                      onChange={(allowed) =>
                        requestPermission({ kind: "guest", guestId: member.guestId }, allowed)
                      }
                    />
                  );
                  const eventChips = (member: FamilyMember) => (
                    <div class="flex flex-wrap gap-1.5">
                      <For each={member.events}>
                        {(eventId) => (
                          <span
                            class="bg-gold/10 text-gold text-ui-xs tracking-ui-wide inline-block rounded-sm px-2 py-0.5 uppercase"
                            title={eventId}
                          >
                            {eventNameById().get(eventId) ?? eventId}
                          </span>
                        )}
                      </For>
                      <Show when={member.events.length === 0}>
                        <span class="text-text-muted text-ui-sm">--</span>
                      </Show>
                    </div>
                  );
                  const plusOneBadge = (member: FamilyMember) => (
                    <Show when={isPlusOne(member)}>
                      {" "}
                      <span class="font-body text-gold-ink border-gold/45 text-ui-xs tracking-ui-wide ml-1 inline-block max-w-full rounded-sm border px-1.5 py-0.5 wrap-break-word">
                        Plus-one of {inviterName(member) || "another guest"}
                      </span>
                    </Show>
                  );
                  return (
                    <div
                      role="group"
                      aria-labelledby={nameId}
                      class="border-border border-b last:border-b-0"
                    >
                      {/* The household's bar: one fixed-height row, stuck
                          under the head strip while the household is on
                          screen, and gone with it. Opaque, so the rows
                          passing under it never show through. */}
                      <div class={HOUSEHOLD_BAR} data-household-bar>
                        <div
                          class={`flex min-w-0 flex-1 items-center gap-2 ${
                            isDeactivated(family) ? "opacity-50" : ""
                          }`}
                        >
                          <span
                            id={nameId}
                            class="font-display text-text text-ui-md min-w-12 truncate"
                          >
                            {family.familyName}
                          </span>
                          {householdBadge(family)}
                        </div>
                        {/* The count, shortened to an icon and a fraction: the
                            narrow bar holds the name, its state and this. */}
                        <Show when={compact() && plusOneControls()}>
                          <span class="font-body text-text-muted text-ui-xs flex shrink-0 items-center gap-1 font-mono">
                            <UserCheck aria-hidden="true" strokeWidth={1.75} class="size-3.5" />
                            <span aria-hidden="true">
                              {permission().allowed}/{permission().total}
                            </span>
                            <span class="sr-only">
                              Plus-ones: {permission().allowed} of {permission().total}
                            </span>
                          </span>
                        </Show>
                        <Show
                          when={compact()}
                          fallback={wideActions(
                            family,
                            permission,
                            householdScope,
                            plusOneControls,
                          )}
                        >
                          {narrowActions(family, permission, householdScope, plusOneControls)}
                        </Show>
                      </div>

                      <Show
                        when={compact()}
                        fallback={
                          <Table
                            scroll="page"
                            aria-labelledby={nameId}
                            frame="none"
                            class={`[&>table]:table-fixed ${ROWS_SCROLL_MARGIN}`}
                          >
                            {colgroup()}
                            {/* The real heads, for assistive technology: kept
                                in the table's layout, their words hidden and
                                the row given no height. The head strip above
                                is what the eye reads. */}
                            <thead>
                              <tr>
                                <For each={HEADS()}>{(name) => <Th srOnly>{name}</Th>}</For>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={visibleMembers()}>
                                {(member, index) => (
                                  <tr class="hover:[&>td]:bg-surface">
                                    <Td valign="middle" class="wrap-break-word">
                                      {member.firstName} {member.lastName}
                                      {plusOneBadge(member)}
                                      <GuestEmailLine member={member} />
                                    </Td>
                                    <Td valign="middle">{eventChips(member)}</Td>
                                    <Show when={plusOnesShown()}>
                                      <Td valign="middle">
                                        {/* A plus-one cannot bring one, so
                                            their row has no switch. */}
                                        <Show when={!isPlusOne(member)}>
                                          {plusOneSwitch(member, true)}
                                        </Show>
                                      </Td>
                                    </Show>
                                    <Td tone="muted" valign="middle" code class="whitespace-nowrap">
                                      <Show when={index() === 0}>{family.publicId}</Show>
                                    </Td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </Table>
                        }
                      >
                        {/* Each guest a block on a narrow panel — name; email;
                            events; their plus-one switch; the household's code
                            once — so nothing scrolls sideways. */}
                        <ul aria-labelledby={nameId} class={ROWS_SCROLL_MARGIN}>
                          <For each={visibleMembers()}>
                            {(member, index) => (
                              <li class="border-border/40 flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
                                <p class="font-body text-text text-ui-base wrap-break-word">
                                  {member.firstName} {member.lastName}
                                  {plusOneBadge(member)}
                                  <GuestEmailLine member={member} />
                                </p>
                                {eventChips(member)}
                                <Show when={plusOnesShown() && !isPlusOne(member)}>
                                  <div class="font-body text-text-muted text-ui-sm">
                                    {plusOneSwitch(member, false)}
                                  </div>
                                </Show>
                                <Show when={index() === 0}>
                                  <p class="text-text-muted text-ui-sm tracking-ui-wide font-mono">
                                    <span class="sr-only">Family code </span>
                                    {family.publicId}
                                  </p>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* The narrow layout's Deactivate confirmation. */}
      <Modal
        open={confirmingDialog() !== null}
        onClose={() => setConfirmingDialog(null)}
        labelledBy={confirmTitleId}
        class="w-full max-w-md"
      >
        <Show when={shownConfirm()}>
          {(family) => {
            let cancel: HTMLButtonElement | undefined;
            onMount(() => cancel?.focus());
            return (
              <div class="flex flex-col gap-4">
                <p id={confirmTitleId} class="font-display text-text text-ui-md font-light">
                  Disable {family().familyName}’s code?
                </p>
                <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                  Their link stops opening the invite. Their guests and replies are kept, and you
                  can reactivate the code at any time.
                </p>
                <div class="flex flex-wrap justify-end gap-2">
                  <Button
                    ref={cancel}
                    variant="quiet"
                    type="button"
                    autofocus
                    onClick={() => setConfirmingDialog(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    type="button"
                    disabled={togglingId() === family().familyId}
                    onClick={() => {
                      const target = family();
                      void toggleDeactivated(target, true).then(() => setConfirmingDialog(null));
                    }}
                  >
                    {togglingId() === family().familyId ? "Deactivating…" : "Deactivate"}
                  </Button>
                </div>
              </div>
            );
          }}
        </Show>
      </Modal>

      {/* Asks before a turn-off that deletes named plus-ones. `onClose` is the
          one place the pending removal is dropped: the dialog also closes on
          Escape and a backdrop click. It opens on Cancel, and closing hands
          focus back to the control that asked. */}
      <Modal
        open={pendingRemoval() !== null}
        onClose={() => setPendingRemoval(null)}
        labelledBy={removalTitleId}
        class="w-full max-w-md"
      >
        <Show when={shownRemoval()}>
          {(removal) => {
            // The body mounts just after `showModal()` has run, which by then
            // has found nothing inside to focus and focused the dialog itself.
            // So Cancel takes focus here; `autofocus` covers a reopen during the
            // exit, when the body is still mounted as the dialog opens.
            let cancel: HTMLButtonElement | undefined;
            onMount(() => cancel?.focus());
            const single = () =>
              removal().scope.kind === "guest" && removal().plusOnes.length === 1
                ? removal().plusOnes[0]!
                : null;
            return (
              <div class="flex flex-col gap-4">
                <p id={removalTitleId} class="font-display text-text text-ui-md font-light">
                  <Show
                    when={single()}
                    fallback={<>Turn off plus-ones for {removal().familyName}?</>}
                  >
                    {(plusOne) => <>Remove {plusOne().name}?</>}
                  </Show>
                </p>
                <Show when={removal().changed}>
                  <Notice tone="warn">
                    The household has changed its plus-ones since the list loaded. Check who this
                    removes now.
                  </Notice>
                </Show>
                <div id={removalBodyId} class="flex flex-col gap-2">
                  <Show
                    when={single()}
                    fallback={
                      <>
                        <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                          This removes{" "}
                          {removal().plusOnes.length === 1
                            ? "the plus-one"
                            : `the ${removal().plusOnes.length} plus-ones`}{" "}
                          the household has named from the guest list, with any replies they have
                          given. This cannot be undone.
                        </p>
                        <ul class="font-body text-text text-ui-sm list-disc pl-5">
                          <For each={removal().plusOnes}>
                            {(plusOne) => (
                              <li>
                                {plusOne.name}
                                <Show when={plusOne.inviterName}>
                                  {(inviter) => (
                                    <span class="text-text-muted"> — {inviter()}’s plus-one</span>
                                  )}
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </>
                    }
                  >
                    {(plusOne) => (
                      <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                        {plusOne().inviterName || "Their guest"} named {plusOne().name} as their
                        plus-one. Turning this off removes {plusOne().name} from the guest list,
                        with any replies they have given. This cannot be undone.
                      </p>
                    )}
                  </Show>
                </div>
                <div class="flex flex-wrap justify-end gap-2">
                  {/* First, and focused on opening: the safe answer is the
                      one under the keyboard. */}
                  <Button
                    ref={cancel}
                    variant="quiet"
                    type="button"
                    autofocus
                    onClick={() => setPendingRemoval(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    type="button"
                    aria-describedby={removalBodyId}
                    onClick={confirmRemoval}
                  >
                    <Show
                      when={single()}
                      fallback={
                        <>
                          Turn off and remove{" "}
                          {removal().plusOnes.length === 1
                            ? removal().plusOnes[0]!.name
                            : removal().plusOnes.length}
                        </>
                      }
                    >
                      {(plusOne) => <>Remove {plusOne().name}</>}
                    </Show>
                  </Button>
                </div>
              </div>
            );
          }}
        </Show>
      </Modal>
    </div>
  );
}
