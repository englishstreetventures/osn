import Button from "@cire/ui/button";
import { tokeniseQuery, tokensPrefixName } from "@shared/db-utils/search";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { heldWhileClosing, Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { Switch } from "@shared/ui/ui/switch";
import { Table, Td, Th } from "@shared/ui/ui/table";
import {
  createComputed,
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
import SectionIntro from "./SectionIntro";

interface FamilyMember {
  /** Identity for `reconcile`: the guest id. */
  key: string;
  guestId: string;
  firstName: string;
  lastName: string;
  events: string[];
  plusOneAllowed?: boolean;
  plusOneOf: string | null;
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
    });
  }
  for (const family of map.values()) family.members = placePlusOnesAfterInviters(family.members);
  return Array.from(map.values());
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
 *  a plan can hold up to 1000 guests (see `deriveCap` in cire-api), and
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
   *  guest credential, so cutting one off (deactivate/reactivate) and marking
   *  one sent are owner-only — the API gates them with weddingOwner(); this
   *  hides the buttons and skips the mark. */
  canManage: boolean;
  /** Owner or editor? Who may bring a plus-one is an editor write (the API
   *  gates it with weddingEditor()); anyone else sees each guest's switch
   *  read-only and no household controls. Absent reads as read-only. */
  canEdit?: boolean;
  /** Display name of the wedding — used in the copied invite message. */
  weddingName: string;
  /** URL slug of the wedding — the copied invite message links to this wedding's
   *  path on the SSR'd, path-routed guest site (`CIRE_WEB_URL/<slug>`). */
  weddingSlug: string;
  /** The line pointing at the other places that shape the invite message, shown
   *  under the introduction. */
  inviteMessageLinks?: JSX.Element;
}

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
   *  API records it for the owner only, so a co-host's copy marks nothing: no
   *  request that can only be refused, and no "Sent" the server never saw. */
  function markShared(family: FamilyGroup) {
    if (!props.canManage) return;
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
   * `weddingMember()` so the owner OR a co-host can export.
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
          toast.error("Only the owner and editors can change plus-ones.");
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

  return (
    <div class="flex flex-col gap-8">
      {/* The pointer to where the message is written sits with the intro, not
          a whole section gap below it. */}
      <div class="flex flex-col gap-3">
        <SectionIntro
          eyebrow="Guest list"
          title="Households, invites & RSVPs"
          description="Everyone you're inviting, grouped into households. Copy a household's invite message to send their link and code, and download replies any time."
          actions={
            <Show when={!loading() && !error() && hasGuests()}>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => void exportCsv("guests")}
                disabled={exporting() !== null}
              >
                {exporting() === "guests" ? "Exporting…" : "Download guests (CSV)"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => void exportCsv("rsvps")}
                disabled={exporting() !== null}
              >
                {exporting() === "rsvps" ? "Exporting…" : "Download RSVPs (CSV)"}
              </Button>
            </Show>
          }
        />
        {props.inviteMessageLinks}
      </div>

      <Show when={loading()}>
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

      <Show when={!loading() && !error() && hasGuests()}>
        <div class="flex flex-wrap items-end justify-between gap-3">
          <p class="font-body text-text-muted text-ui-sm">
            {guests().length} {guests().length === 1 ? "guest" : "guests"} across {families.length}{" "}
            {families.length === 1 ? "household" : "households"}
          </p>
          <Field label="Search guests" labelHidden class="w-full max-w-64">
            {(field) => (
              <Input
                {...field}
                type="search"
                size="sm"
                value={searchInput()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
                placeholder="Search by name, household or code…"
              />
            )}
          </Field>
        </div>

        <Show when={visibleFamilies().length === 0}>
          <p class="font-body text-text-muted text-ui-sm italic">
            No guests match “{search().trim()}”.
          </p>
        </Show>

        <Show when={visibleFamilies().length > 0}>
          <Table label="Guests">
            <thead>
              <tr>
                <Th>Guest Name</Th>
                <Th>Events</Th>
                <Show when={plusOnesShown()}>
                  <Th>Plus-one</Th>
                </Show>
                <Th>Family Code</Th>
              </tr>
            </thead>
            <tbody>
              <For each={visibleFamilies()}>
                {(family) => {
                  // Which of this household's members to show — reactive on
                  // `search()` and the household's own members, so a keystroke
                  // that leaves this household's own visibility unchanged (see
                  // `visibleFamilies` above) still updates its member rows
                  // without the outer `<For>` remounting the whole row.
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
                  return (
                    <>
                      <tr>
                        <td
                          colspan={plusOnesShown() ? 4 : 3}
                          class={`border-border bg-surface/50 border-b px-4 py-2 ${
                            isDeactivated(family) ? "opacity-50" : ""
                          }`}
                        >
                          <div class="flex flex-wrap items-center justify-between gap-3">
                            <span class="font-display text-gold-dim text-ui-md flex items-center gap-2">
                              {family.familyName}
                              <Show when={isDeactivated(family)}>
                                <span
                                  class="font-body border-error/40 text-error text-ui-xs tracking-ui-widest rounded-sm border px-1.5 py-0.5 uppercase not-italic"
                                  title="Deactivated — this household's code no longer opens the invite. Reactivate to restore it."
                                >
                                  Deactivated — code disabled
                                </span>
                              </Show>
                              {/* Status badges are suppressed while deactivated —
                                the "Deactivated" label is the only relevant state
                                then. "Opened" (a real guest claim) otherwise takes
                                precedence over the copy-only "Sent". */}
                              <Show when={!isDeactivated(family)}>
                                <Show
                                  when={isOpened(family)}
                                  fallback={
                                    <Show when={isShared(family)}>
                                      <span
                                        class="font-body text-gold/80 border-gold/30 text-ui-xs tracking-ui-widest rounded-sm border px-1.5 py-0.5 uppercase not-italic"
                                        title="Sent — you copied this family's invite message"
                                      >
                                        Sent
                                      </span>
                                    </Show>
                                  }
                                >
                                  <span
                                    class="font-body bg-gold text-bg text-ui-xs tracking-ui-widest rounded-sm px-1.5 py-0.5 uppercase not-italic"
                                    title={`Opened — a guest opened this invite (code used) on ${formatOpenedDate(
                                      family.firstOpenedAt!,
                                    )}`}
                                  >
                                    Opened
                                  </span>
                                </Show>
                              </Show>
                            </span>
                            <div class="flex flex-wrap items-center gap-2">
                              {/* Editors only: these write. A viewer reads each
                                  guest's switch instead. */}
                              <Show when={plusOnesShown() && canEdit() && permission().total > 0}>
                                <fieldset class="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
                                  <legend class="sr-only">
                                    Plus-ones for the {family.familyName} household
                                  </legend>
                                  <span class="font-body text-text-muted text-ui-xs tracking-ui-wide">
                                    Plus-ones: {permission().allowed} of {permission().total}
                                  </span>
                                  {/* `aria-disabled`, never `disabled`: the
                                      button keeps focus through its own write
                                      and stays reachable when it would change
                                      nothing. */}
                                  <Button
                                    variant="quiet"
                                    size="sm"
                                    type="button"
                                    aria-disabled={permission().allowed === permission().total}
                                    aria-busy={isBusy(busyKey(householdScope)) ? "true" : undefined}
                                    onClick={() => requestPermission(householdScope, true)}
                                  >
                                    Allow everyone
                                  </Button>
                                  <Button
                                    variant="quiet"
                                    size="sm"
                                    type="button"
                                    aria-disabled={permission().allowed === 0}
                                    aria-busy={isBusy(busyKey(householdScope)) ? "true" : undefined}
                                    onClick={() => requestPermission(householdScope, false)}
                                  >
                                    Allow no one
                                  </Button>
                                </fieldset>
                              </Show>
                              <Button
                                variant="quiet"
                                size="sm"
                                type="button"
                                disabled={!messageSettled()}
                                onClick={() => void copyMessage(family)}
                              >
                                Copy message
                              </Button>
                              {/* Deactivate is confirm-gated (cuts off a live code);
                                Reactivate is a direct restore. Owner-only —
                                code management sits above editor writes. */}
                              <Show when={props.canManage}>
                                <Show
                                  when={isDeactivated(family)}
                                  fallback={
                                    <Show
                                      when={confirmingId() === family.familyId}
                                      fallback={
                                        <Button
                                          variant="quietDanger"
                                          size="sm"
                                          type="button"
                                          onClick={() => setConfirmingId(family.familyId)}
                                          disabled={togglingId() === family.familyId}
                                          title="Disable this household's code (e.g. a withdrawn invite). Reversible — their guests and RSVPs are kept."
                                        >
                                          Deactivate
                                        </Button>
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
                                        {togglingId() === family.familyId
                                          ? "Deactivating…"
                                          : "Confirm"}
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
                                  }
                                >
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    type="button"
                                    onClick={() => void toggleDeactivated(family, false)}
                                    disabled={togglingId() === family.familyId}

                                    title="Re-enable this household's code — their guests and RSVPs were kept."
                                  >
                                    {togglingId() === family.familyId
                                      ? "Reactivating…"
                                      : "Reactivate"}
                                  </Button>
                                </Show>
                              </Show>
                            </div>
                          </div>
                        </td>
                      </tr>
                      <For each={visibleMembers()}>
                        {(member, index) => (
                          <tr class="hover:[&>td]:bg-surface">
                            <Td valign="middle" indent>
                              {member.firstName} {member.lastName}
                              <Show when={isPlusOne(member)}>
                                {" "}
                                <span class="font-body text-gold-ink border-gold/45 text-ui-xs tracking-ui-wide ml-1 inline-block rounded-sm border px-1.5 py-0.5 whitespace-nowrap">
                                  Plus-one of {inviterName(member) || "another guest"}
                                </span>
                              </Show>
                            </Td>
                            <Td valign="middle">
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
                            </Td>
                            <Show when={plusOnesShown()}>
                              <Td valign="middle">
                                {/* A plus-one cannot bring one, so their row
                                    has no switch. */}
                                <Show when={!isPlusOne(member)}>
                                  <Switch
                                    checked={member.plusOneAllowed === true}
                                    label={`${fullName(member)} may bring a plus-one`}
                                    labelHidden
                                    readOnly={!canEdit()}
                                    busy={
                                      isBusy(`guest:${member.guestId}`) ||
                                      isBusy(busyKey(householdScope))
                                    }
                                    onChange={(allowed) =>
                                      requestPermission(
                                        { kind: "guest", guestId: member.guestId },
                                        allowed,
                                      )
                                    }
                                  />
                                </Show>
                              </Td>
                            </Show>
                            <Td tone="muted" valign="middle" code>
                              <Show when={index() === 0}>{family.publicId}</Show>
                            </Td>
                          </tr>
                        )}
                      </For>
                    </>
                  );
                }}
              </For>
            </tbody>
          </Table>
        </Show>
      </Show>

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
