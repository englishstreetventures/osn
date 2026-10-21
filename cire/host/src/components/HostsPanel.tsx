import Button from "@cire/ui/button";
import { UsernameInput } from "@cire/ui/username-input";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field, Fieldset } from "@shared/ui/ui/field";
import { heldWhileClosing, Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { Select } from "@shared/ui/ui/select";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { haptic } from "../lib/haptics";
import { type HostSeat, invalidateHosts, setFreshHosts } from "../lib/hosts-store";
import { useMembersChanged } from "../lib/members-changed";
import {
  atPeopleLimit,
  peopleCountLabel,
  peopleLimitMessage,
  type PeopleLimit,
  readPeopleLimit,
  upgradeTierFor,
} from "../lib/people-limit";
import {
  readRunSheetScope,
  RUN_SHEET_SCOPE_COPY,
  RUN_SHEET_SCOPES,
  type RunSheetScope,
} from "../lib/run-sheet-scope";
import { invalidateTasks, peekCachedTasks } from "../lib/tasks-store";
import { type PaidTier, TIER_LABEL } from "../lib/tiers";
import {
  type AssignableRole,
  assignableRolesFor,
  needsRoleChangeConfirmation,
  NEW_SEAT_ROLE,
  normaliseWeddingRole,
  ROLE_COPY,
  surfacesFor,
  type WeddingRole,
} from "../lib/wedding-roles";
import LeaveWedding from "./LeaveWedding";
import SectionIntro from "./SectionIntro";
import UpgradeDialog from "./UpgradeDialog";

/** A seat on the wedding — an owner's or a co-host's. Owners are seats like
 *  everyone else, so one shape serves both. */
interface HostRow {
  /** The seat id a checklist task's `assigneeHostIds` name. Absent on the add
   *  response, which does not echo it. */
  hostId?: string;
  osnProfileId: string;
  /** The person's OSN handle: echoed by the add response, and on the list when
   *  its lookup resolved one. A row without one shows the profile id. */
  handle?: string;
  /** The person's OSN display name, when the list's lookup resolved one. */
  displayName?: string;
  /** The person's OSN photo, an https URL, when the list's lookup found one.
   *  The panel draws none; it hands it to the checklist's holder faces. */
  avatarUrl?: string;
  role: WeddingRole;
  createdAt: number;
  /** Who created this seat. Absent on the add response (it is by definition the
   *  caller) and on a mid-deploy payload from an older API. */
  addedByOsnProfileId?: string;
  /** The adder's handle when the batch lookup resolved it. */
  addedByHandle?: string;
  /** How far into the run sheet a helper sees, as the API sent it: on helper
   *  rows only. Read through `scopeOf`, which takes anything else as `own`. */
  runSheetScope?: string;
}

/**
 * A role change waiting on an owner to say yes.
 *
 * Held rather than applied because it either hands over a wide grant (owner,
 * editor) or is the owner stepping down from their own seat. While it is held,
 * the row's select shows `to` — the option the owner picked — and dropping this
 * puts the select back on the seat's own role, which is still whatever it was:
 * nothing has been sent.
 */
interface PendingPromotion {
  host: HostRow;
  to: AssignableRole;
  /** The caller's own seat: confirming steps them down. */
  ownSeat: boolean;
}

/** Every row the API hands back, with its role narrowed to one the portal
 *  knows. */
const withKnownRole = (host: HostRow): HostRow => ({
  ...host,
  role: normaliseWeddingRole(host.role),
});

/**
 * The list as the checklist's seat cache holds it, in the API's order with the
 * roles already narrowed, or `null` when a row has no seat id (an API older
 * than the field), which leaves the checklist to read the seats itself.
 */
function asSeats(rows: readonly HostRow[]): HostSeat[] | null {
  const seats: HostSeat[] = [];
  for (const { hostId, osnProfileId, handle, displayName, avatarUrl, role } of rows) {
    if (!hostId) return null;
    seats.push({ hostId, osnProfileId, handle, displayName, avatarUrl, role });
  }
  return seats;
}

/** Owners first, then everyone else, each group in the order the API listed
 *  them (oldest seat first). */
const ownersFirst = (rows: readonly HostRow[]): HostRow[] =>
  rows.toSorted((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));

/** What a refused seat change says, by the API's error string. */
const SEAT_REFUSALS = {
  last_owner: "A wedding always keeps at least one owner. Make someone else an owner first.",
  host_cap_reached: "This wedding has as many hosts as it can hold, owners included.",
  already_host: "That person is already a host.",
  not_a_helper:
    "They aren't a helper any more, so there is no run sheet to change. Reload to see their role.",
} as const;

type SeatRefusal = keyof typeof SEAT_REFUSALS;

/** What a refused seat change said: the words for it, if this panel words it,
 *  and the people count a `people_limit_reached` refusal carries. */
interface Refusal {
  message: string | null;
  peopleLimit: PeopleLimit | null;
}

/**
 * Read a 4xx body once — a response body can be read only once — into the
 * refusal it names. `Object.hasOwn`, never `in`: a body naming `constructor`
 * is not a refusal.
 */
async function readRefusal(res: Response): Promise<Refusal> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (body.error === "people_limit_reached") {
    const peopleLimit = readPeopleLimit(body);
    return {
      message: peopleLimit
        ? peopleLimitMessage(peopleLimit)
        : "This wedding has reached its plan's limit of people.",
      peopleLimit,
    };
  }
  return {
    message:
      typeof body.error === "string" && Object.hasOwn(SEAT_REFUSALS, body.error)
        ? SEAT_REFUSALS[body.error as SeatRefusal]
        : null,
    peopleLimit: null,
  };
}

/** The people count on a successful response's body, if it carries one. */
async function peopleLimitIn(res: Response): Promise<PeopleLimit | null> {
  const body = (await res.json().catch(() => null)) as { peopleLimit?: unknown } | null;
  return readPeopleLimit(body?.peopleLimit);
}

/** One autocomplete suggestion from `GET /api/organiser/handle-search`. */
interface HandleSuggestion {
  profileId: string;
  handle: string;
  displayName: string | null;
  /**
   * True when this profile is one of the organiser's own OSN connections. The
   * API ranks these first; the badge tells the organiser which of two similar
   * handles is the person they actually know — worth surfacing when the click
   * hands someone write access to a guest list.
   */
  connected?: boolean;
}

/** Debounce window (ms) before a typed prefix triggers a handle-search fetch. */
const SEARCH_DEBOUNCE_MS = 280;
/** Stable DOM id for the suggestion listbox (aria-controls target). */
const LISTBOX_ID = "host-handle-suggestions";
/** Per-option DOM id, referenced by aria-activedescendant for keyboard nav. */
const optionId = (i: number) => `host-handle-option-${i}`;

interface HostsPanelProps {
  weddingId: string;
  /** The signed-in organiser's role on this wedding. `surfacesFor()` turns it
   *  into what this panel offers: adding someone, and changing or removing a
   *  seat, are an owner's alone (`weddingOwner()` on every one of those
   *  routes). Not named `role`: on a JSX element that reads as an ARIA role. */
  callerRole: WeddingRole;
  /** True for every seat holder (`weddingSeat()` on `DELETE /hosts/me`). An
   *  owner may leave too while another owner remains; the API refuses the last
   *  owner with 409 `last_owner`. */
  canLeave?: boolean;
  /** Called once the caller has left the wedding, after the confirmation
   *  toast. The parent drops the wedding from the organiser's list, which
   *  unmounts this panel and releases the wedding's cached rows. */
  onLeft?: () => void;
  /** Called with the caller's new role once the API has changed their OWN
   *  seat — an owner stepping down. The parent patches the wedding's role, and
   *  every view re-derives what it offers from it, this panel included. */
  onOwnRoleChanged?: (role: WeddingRole) => void;
}

/**
 * Hosts section of a wedding's dashboard. Lists everyone seated on the wedding,
 * owners first; owners alone add someone by OSN handle, change a role or remove
 * a seat, and anyone seated here can leave.
 *
 * Owners are equals: any owner can make another, demote or remove one, or step
 * down from their own seat — and the API refuses whichever change would leave
 * the wedding with no owner. Everyone else sees the list and nothing to change
 * in it. Offering a control here that the API would 403 is the failure this
 * mirroring avoids.
 */
export default function HostsPanel(props: HostsPanelProps) {
  const { authFetch, activeProfileId } = useAuth();
  const surfaces = () => surfacesFor(props.callerRole);
  const canManage = () => surfaces().canManage;
  /** The roles this caller may put on a seat — the dropdown and the explainers. */
  const grantable = () => assignableRolesFor(props.callerRole);
  const isMe = (host: HostRow) => host.osnProfileId === activeProfileId();
  const [hosts, setHosts] = createSignal<HostRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [handle, setHandle] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);
  // Profile id of the host whose role change is in flight (disables its select).
  const [roleBusyId, setRoleBusyId] = createSignal<string | null>(null);
  // The promotion waiting on a yes, or null. Held rather than sent: see
  // `PendingPromotion`.
  const [pending, setPending] = createSignal<PendingPromotion | null>(null);
  // What the dialog renders. `Modal` unmounts its children only once the exit
  // has played, and the body names a person — without this it would blank
  // mid-fade. Built once, here: each call makes its own signal and effect.
  const shownPromotion = heldWhileClosing(pending);
  // A helper's run-sheet scope as this visit has changed it, held beside the
  // rows and keyed by the row object, never written into the rows: `<For>`
  // re-creates a row it is handed as a new object, and the select an owner is
  // on would go with it, taking their focus. A row rebuilt for anything else —
  // a role change, a reload — is a new key, so it reads its own
  // `runSheetScope` again.
  // The scope each helper's write in flight is setting. Their select shows it
  // and is announced busy until the write ends; a failed write ends with its
  // entry gone, which puts the select back.
  const [scopeWrites, setScopeWrites] = createSignal<ReadonlyMap<HostRow, RunSheetScope>>(
    new Map(),
  );
  // The scope each helper's last accepted write set.
  const [scopesSet, setScopesSet] = createSignal<ReadonlyMap<HostRow, RunSheetScope>>(new Map());
  // The helper whose run sheet is waiting on a yes before it is opened to every
  // task. Held, not sent, like a promotion: see `selectScope`.
  const [pendingScope, setPendingScope] = createSignal<HostRow | null>(null);
  const shownScope = heldWhileClosing(pendingScope);
  // True row count from the API; compared against what we rendered.
  const [total, setTotal] = createSignal(0);
  const truncated = () => total() > hosts().length;
  const hasCohosts = () => hosts().some((h) => h.role !== "owner");

  // The people count against the plan's limit, as the API last reported it —
  // on the list and on every add, role change and removal. `null` from an API
  // that sends none, which leaves the panel as it was before limits.
  const [peopleLimit, setPeopleLimit] = createSignal<PeopleLimit | null>(null);
  const keepPeopleLimit = (next: PeopleLimit | null) => {
    if (next) setPeopleLimit(next);
  };
  const atLimit = () => {
    const limit = peopleLimit();
    return limit !== null && atPeopleLimit(limit);
  };
  // The couple's two owner seats never count, so a wedding at its limit — not
  // over it, which adds no one — with one owner can still seat the second, as
  // an owner, which the add form then asks for. Read off the list, which holds
  // every seat (the seat cap keeps it under the list ceiling); the API decides
  // either way.
  const canAddSecondOwner = () => {
    const limit = peopleLimit();
    return (
      limit !== null &&
      limit.used === limit.limit &&
      hosts().filter((h) => h.role === "owner").length < 2
    );
  };
  const showsAddForm = () => canManage() && (!atLimit() || canAddSecondOwner());
  // The notice that takes the add form's place at the limit. When an add the
  // owner just made brings it in, focus moves to it and it is announced, so a
  // keyboard or screen-reader user is not left on a field that has gone.
  let limitNotice: HTMLDivElement | undefined;
  const [limitJustReached, setLimitJustReached] = createSignal(false);
  const noticeIfFormGone = (hadForm: boolean) => {
    if (!hadForm || showsAddForm()) return;
    setLimitJustReached(true);
    limitNotice?.focus();
  };
  // The tier the purchase dialog sells while it is open. Mounted afresh per
  // open, like the nav's: the dialog keeps its own attempt and submit state.
  const [offer, setOffer] = createSignal<PaidTier | null>(null);
  // A handle waiting on a yes before it is seated as an owner.
  const [pendingOwnerAdd, setPendingOwnerAdd] = createSignal<string | null>(null);
  const shownOwnerAdd = heldWhileClosing(pendingOwnerAdd);
  // `Field` takes a list; this form only ever raises the one message at a time.
  const addErrors = () => {
    const message = addError();
    return message ? [message] : undefined;
  };

  // --- Handle autocomplete state ---------------------------------------------
  const [suggestions, setSuggestions] = createSignal<HandleSuggestion[]>([]);
  const [open, setOpen] = createSignal(false);
  // Index of the keyboard-highlighted suggestion; -1 = none highlighted.
  const [activeIdx, setActiveIdx] = createSignal(-1);
  // True while the open dropdown is showing the organiser's connections with
  // nothing typed — the on-focus case, which gets its own caption.
  const [browsingConnections, setBrowsingConnections] = createSignal(false);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // Monotonic request id so a slow earlier fetch can't clobber a newer result.
  let searchSeq = 0;
  // Aborts the superseded request rather than merely ignoring its result. The
  // `searchSeq` check alone spaces out request *starts*; without an abort a
  // fast typist leaves several fetches running to completion, each still
  // costing its two upstream S2S calls. Focus bypasses the debounce entirely,
  // so this is also what stops the on-focus fetch racing the first keystroke.
  let inFlight: AbortController | undefined;
  // One connections fetch per mount: re-focusing (or backspacing back to) an
  // empty input shows the cached list rather than re-hitting the endpoint,
  // whose upstream query costs a scan of the organiser's whole connection list.
  // The list is cached SEPARATELY from `suggestions` — restoring from
  // `suggestions` would re-show whatever the last *typed* search returned, under
  // the "From your OSN connections" caption, which is a different list wearing
  // the wrong label.
  let connectionsFetched = false;
  let cachedConnections: HandleSuggestion[] = [];

  onCleanup(() => inFlight?.abort());

  const endpoint = () => apiUrl(weddingPath(props.weddingId, "/hosts"));

  onCleanup(() => clearTimeout(debounceTimer));

  function closeSuggestions() {
    setOpen(false);
    setActiveIdx(-1);
  }

  /**
   * Fetch suggestions for the current input, debounced + race-safe.
   *
   * Every input length is meaningful, so there is no client-side floor: an
   * EMPTY query asks for the organiser's own OSN connections (what the dropdown
   * shows on focus, before a keystroke), and a one-character query still filters
   * those connections. The global handle search keeps its own two-character
   * floor server-side, so a short query simply comes back with connections only.
   */
  async function runSearch(raw: string) {
    const q = raw.trim();
    // An empty query has ONE answer per mount — the organiser's connections —
    // so serve the cached list instead of re-asking. This is the backspace-to-
    // empty path; `onHandleFocus` guards the other way in.
    if (q.length === 0) {
      if (connectionsFetched && cachedConnections.length > 0) {
        setSuggestions(cachedConnections);
        setActiveIdx(-1);
        setBrowsingConnections(true);
        setOpen(true);
        return;
      }
      // Marked before the request, not after, so an empty result doesn't leave
      // the flag false and refetch on every subsequent focus or backspace.
      connectionsFetched = true;
    }
    const seq = ++searchSeq;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/handle-search?q=${encodeURIComponent(q)}`),
        { signal: controller.signal },
      );
      // A newer keystroke already superseded this request — drop the result.
      if (seq !== searchSeq) return;
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        // FAIL-SOFT: a search outage must never block manual typing.
        setSuggestions([]);
        closeSuggestions();
        return;
      }
      const body = (await res.json()) as { profiles?: HandleSuggestion[] };
      const list = Array.isArray(body.profiles) ? body.profiles : [];
      if (q.length === 0) cachedConnections = list;
      setSuggestions(list);
      setActiveIdx(-1);
      setBrowsingConnections(q.length === 0);
      setOpen(list.length > 0);
    } catch (err) {
      if (seq !== searchSeq) return;
      // An abort is our own doing (a newer search, or unmount) — never a
      // reason to clear a list the newer request is about to replace.
      if (controller.signal.aborted) return;
      if (isAuthExpired(err)) return redirectToLogin();
      // Network blip — fail soft, keep the manual path usable.
      setSuggestions([]);
      closeSuggestions();
    }
  }

  function onHandleInput(raw: string) {
    // `UsernameInput` shows a fixed "@" ahead of the box, so the box's own
    // value never carries one — strip a leading "@" a paste might still drop
    // in (the input isn't restricted to what a keystroke can produce).
    const value = raw.replace(/^@+/, "");
    setHandle(value);
    setAddError(null);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(value), SEARCH_DEBOUNCE_MS);
  }

  /**
   * Focus: re-open the cached list if there is one, otherwise — with nothing
   * typed — pull the organiser's OSN connections so the person they're most
   * likely adding is one click away, before any keystroke. Fetched once per
   * mount; a search outage just leaves the dropdown closed.
   */
  async function onHandleFocus() {
    if (suggestions().length > 0) {
      setOpen(true);
      return;
    }
    // Something already typed ⇒ leave their filtered results alone; refetching
    // "" here would swap them for the unfiltered connections list mid-edit.
    if (handle().trim().length > 0 || connectionsFetched) return;
    await runSearch("");
  }

  /** Pick a suggestion: fill the input with its handle and close the list. */
  function pick(s: HandleSuggestion) {
    setHandle(s.handle);
    setSuggestions([]);
    closeSuggestions();
  }

  function onHandleKeyDown(e: KeyboardEvent) {
    if (!open() || suggestions().length === 0) {
      // ArrowDown re-opens the list if we have stale suggestions to show.
      if (e.key === "ArrowDown" && suggestions().length > 0) {
        e.preventDefault();
        setOpen(true);
        setActiveIdx(0);
      }
      return;
    }
    const last = suggestions().length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => (i >= last ? 0 : i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => (i <= 0 ? last : i - 1));
        break;
      case "Enter": {
        const i = activeIdx();
        if (i >= 0 && i <= last) {
          // Choosing a suggestion shouldn't also submit the add form.
          e.preventDefault();
          pick(suggestions()[i]!);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        closeSuggestions();
        break;
    }
  }

  // Each read's number; only the newest read's answer is kept.
  let loadSeq = 0;

  /** Apply this panel's own write to the list. A read already in flight may
   *  predate the write, so its answer is dropped; the write's own signal asks
   *  again. */
  function setLocalHosts(update: (prev: HostRow[]) => HostRow[]): void {
    loadSeq += 1;
    setHosts(update);
  }

  /**
   * Read the seats. The first read fills the panel and shows its error; a
   * later one, prompted by the open wedding's socket, replaces the list
   * quietly and keeps what is on screen if it fails.
   */
  async function loadHosts(first: boolean) {
    const seq = ++loadSeq;
    try {
      const res = await authFetch(endpoint());
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error("Failed to load");
      const body = (await res.json()) as {
        hosts: HostRow[];
        total?: number;
        peopleLimit?: unknown;
      };
      if (seq !== loadSeq) return;
      const rows = body.hosts.map(withKnownRole);
      // A seat the read shows as this panel already does keeps its row object,
      // so `<For>` keeps its row, its controls and the focus of an owner on
      // one of them; only a changed seat is rebuilt.
      const onScreen = new Map(untrack(hosts).map((h) => [h.osnProfileId, h]));
      setHosts(
        ownersFirst(
          rows.map((row) => {
            const shown = onScreen.get(row.osnProfileId);
            return shown && showsAs(shown, row) ? shown : row;
          }),
        ),
      );
      // The checklist names who holds each task from this same list, so it
      // takes this read rather than making its own.
      const seats = asSeats(rows);
      if (seats) setFreshHosts(props.weddingId, seats);
      keepPeopleLimit(readPeopleLimit(body.peopleLimit));
      // `total` > the rows we got means the API truncated. Surfaced rather than
      // ignored: an owner shown a partial list has no way to know that someone
      // who can read their guests' data is missing from it.
      setTotal(body.total ?? body.hosts.length);
      setError(null);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      if (first && seq === loadSeq) setError("Could not load hosts. Is the API running?");
    } finally {
      if (first) setLoading(false);
    }
  }

  onMount(() => void loadHosts(true));

  // The open wedding's socket says its seats may have changed, from someone
  // else's tab or this one's own write: read them again.
  createEffect(on(useMembersChanged(), () => void loadHosts(false), { defer: true }));

  function add(e: Event) {
    e.preventDefault();
    const value = handle().trim();
    if (!value) {
      setAddError("Enter an OSN handle, like @alice.");
      return;
    }
    setAddError(null);
    closeSuggestions();
    // At the limit only a second owner can join, and making someone an owner
    // hands them every owner power, so that add asks first.
    if (canAddSecondOwner()) {
      setPendingOwnerAdd(value);
      return;
    }
    void submitAdd(value, NEW_SEAT_ROLE);
  }

  async function submitAdd(value: string, role: AssignableRole) {
    setAddError(null);
    setAdding(true);
    const hadForm = showsAddForm();
    try {
      const res = await authFetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sent rather than left to the API's own default, so the seat this
        // panel creates is the one it shows in the row's dropdown a moment
        // later whatever version of the API answered.
        body: JSON.stringify({ handle: `@${value}`, role }),
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 404) {
        haptic("reject");
        setAddError(`No OSN account found for @${value}.`);
        return;
      }
      if (res.status === 409) {
        haptic("reject");
        const refusal = await readRefusal(res);
        setAddError(refusal.message ?? "That person is already a host.");
        // At the limit the offer replaces the form and says why itself.
        keepPeopleLimit(refusal.peopleLimit);
        noticeIfFormGone(hadForm);
        return;
      }
      if (res.status === 403) {
        haptic("reject");
        setAddError("Only an owner can add someone to this wedding.");
        return;
      }
      if (res.status === 503) {
        haptic("reject");
        setAddError("Adding hosts isn't available on this deployment yet.");
        return;
      }
      if (!res.ok) {
        haptic("reject");
        setAddError("Could not add that host. Please try again.");
        return;
      }
      const body = (await res.json()) as { host: HostRow; peopleLimit?: unknown };
      const added = withKnownRole(body.host);
      setLocalHosts((prev) => ownersFirst([...prev, added]));
      // The checklist offers everyone seated as a task's holder.
      invalidateHosts(props.weddingId);
      keepPeopleLimit(readPeopleLimit(body.peopleLimit));
      noticeIfFormGone(hadForm);
      setHandle("");
      setSuggestions([]);
      // The just-added host is now an existing co-host, so the cached connection
      // list is stale — let the next focus pull a fresh one. Left cached, it
      // would keep offering someone whose click now leads straight to a 409.
      connectionsFetched = false;
      cachedConnections = [];
      haptic("commit");
      toast.success(
        `Added ${added.handle ? `@${added.handle}` : "host"} as a ${ROLE_COPY[
          added.role
        ].label.toLowerCase()}. Change that from their row.`,
      );
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setAddError("Could not add that host. Is the API running?");
    } finally {
      setAdding(false);
    }
  }

  async function remove(host: HostRow) {
    const label = host.handle ? `@${host.handle}` : host.osnProfileId;
    try {
      const res = await authFetch(`${endpoint()}/${encodeURIComponent(host.osnProfileId)}`, {
        method: "DELETE",
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        haptic("reject");
        toast.error(
          (await readRefusal(res)).message ?? "Could not remove that host. Please try again.",
        );
        return;
      }
      keepPeopleLimit(await peopleLimitIn(res));
      setLocalHosts((prev) => prev.filter((h) => h.osnProfileId !== host.osnProfileId));
      // The server took this seat off its checklist tasks with it, so a cached
      // checklist that names the seat among a task's holders names someone who
      // holds nothing; one that does not name it is unchanged. A seat added on
      // this visit has no id here, so it might be named.
      const { hostId } = host;
      if (
        hostId === undefined ||
        peekCachedTasks(props.weddingId)?.some((t) => t.assigneeHostIds.includes(hostId))
      ) {
        invalidateTasks(props.weddingId);
      }
      invalidateHosts(props.weddingId);
      haptic("commit");
      toast.success(`Removed ${label}.`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("Could not remove that host. Is the API running?");
    }
  }

  /** A name for a host that reads in a sentence. */
  const nameOf = (host: HostRow) => (host.handle ? `@${host.handle}` : host.osnProfileId);

  /** What a helper row says they see: what this visit last set, else what the
   *  API sent. A row the API sent no scope for, or one the portal does not
   *  know, reads as the narrow one. */
  const scopeOf = (host: HostRow): RunSheetScope =>
    scopesSet().get(host) ?? readRunSheetScope(host.runSheetScope, "own");

  /** Does a freshly read seat show exactly as `shown` does now? Every field
   *  must match but the scope, which is compared with what the row shows — a
   *  write of this visit's in flight or accepted included — not with what the
   *  API last sent for it. */
  const showsAs = (shown: HostRow, read: HostRow): boolean => {
    const fields = new Set([...Object.keys(shown), ...Object.keys(read)]) as Set<keyof HostRow>;
    fields.delete("runSheetScope");
    for (const field of fields) if (shown[field] !== read[field]) return false;
    const showing = untrack(scopeWrites).get(shown) ?? untrack(() => scopeOf(shown));
    return showing === readRunSheetScope(read.runSheetScope, "own");
  };

  /** What an owner's scope select shows: the pick while the widening is being
   *  asked about, the scope a write in flight is setting, and the seat's own
   *  otherwise. The option picked changed the DOM at once, so a change to this
   *  is the only thing that puts the select back. */
  const scopeShownFor = (host: HostRow): RunSheetScope =>
    pendingScope()?.osnProfileId === host.osnProfileId
      ? "full"
      : (scopeWrites().get(host) ?? scopeOf(host));

  /**
   * The scope dropdown moved. Narrowing goes straight through: it takes away
   * nothing an owner cannot hand straight back. Opening the whole run sheet asks
   * first, because it shows the helper everyone else's jobs and names — and the
   * select stays on the pick while it asks, as a promotion's does.
   *
   * The select is never disabled while its write is out, so it keeps the focus
   * of an owner on the keyboard, where one arrow key is a pick. A pick then
   * sends nothing and the select goes back to what is being written.
   */
  function selectScope(host: HostRow, select: HTMLSelectElement) {
    if (scopeWrites().has(host)) {
      select.value = scopeShownFor(host);
      return;
    }
    const next = select.value as RunSheetScope;
    if (next === "full") {
      setPendingScope(host);
      return;
    }
    void changeScope(host, next);
  }

  /** Set a helper's run-sheet scope (owner-only; the API re-checks). The
   *  checklist reads no scope, so its seat cache stays as it is. The API tells
   *  the helper's open tab, and every co-host panel, through the wedding's
   *  socket. */
  async function changeScope(host: HostRow, next: RunSheetScope) {
    setScopeWrites((writes) => new Map(writes).set(host, next));
    try {
      const res = await authFetch(
        `${endpoint()}/${encodeURIComponent(host.osnProfileId)}/run-sheet-scope`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: next }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        haptic("reject");
        const refusal = await readRefusal(res);
        toast.error(refusal.message ?? "Could not change what they see. Please try again.");
        return;
      }
      haptic("commit");
      // A read already in flight may predate the write, so its answer is
      // dropped, as `setLocalHosts` drops one; the write's own signal asks
      // again.
      loadSeq += 1;
      setScopesSet((set) => new Map(set).set(host, next));
      toast.success(`${nameOf(host)} now sees ${RUN_SHEET_SCOPE_COPY[next].phrase}.`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("Could not change what they see. Is the API running?");
    } finally {
      setScopeWrites((writes) => {
        const left = new Map(writes);
        left.delete(host);
        return left;
      });
    }
  }

  /** The role this host's select should show while a promotion of theirs is
   *  waiting on a yes, or `null` when nothing of theirs is pending. */
  const pendingRoleFor = (host: HostRow): AssignableRole | null => {
    const promotion = pending();
    return promotion?.host.osnProfileId === host.osnProfileId ? promotion.to : null;
  };

  /**
   * The dropdown moved. Either ask first or go straight through.
   *
   * Nothing is sent from here when a confirmation is owed — the select has
   * already changed in the DOM, so the pending change also carries where it
   * came from, and dismissing the dialog puts it back.
   */
  function selectRole(host: HostRow, nextRole: AssignableRole) {
    if (nextRole === host.role) return;
    const ownSeat = isMe(host);
    if (needsRoleChangeConfirmation(host.role, nextRole, ownSeat)) {
      setPending({ host, to: nextRole, ownSeat });
      return;
    }
    void changeRole(host, nextRole);
  }

  /** Set a seat's role (owner-only; the API re-checks). */
  async function changeRole(host: HostRow, nextRole: AssignableRole) {
    const label = nameOf(host);
    setRoleBusyId(host.osnProfileId);
    try {
      const res = await authFetch(`${endpoint()}/${encodeURIComponent(host.osnProfileId)}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        haptic("reject");
        const refusal = await readRefusal(res);
        keepPeopleLimit(refusal.peopleLimit);
        // The select already shows the refused role in the DOM, and its value
        // expression has not changed, so nothing would put it back. A fresh
        // copy of the seat re-renders the row from the role it still holds.
        setLocalHosts((prev) =>
          prev.map((h) => (h.osnProfileId === host.osnProfileId ? { ...h } : h)),
        );
        toast.error(refusal.message ?? "Could not change that host's role. Please try again.");
        return;
      }
      // Read once, for the people count and the seat's run-sheet scope. The
      // scope is the API's: it resets it on every role change but helper to
      // helper, and only the stored role says which this was — another owner
      // may have made the seat a helper since this list was read.
      const answer = (await res.json().catch(() => null)) as {
        peopleLimit?: unknown;
        host?: { runSheetScope?: unknown } | null;
      } | null;
      keepPeopleLimit(readPeopleLimit(answer?.peopleLimit));
      haptic("commit");
      setLocalHosts((prev) =>
        ownersFirst(
          prev.map((h) =>
            h.osnProfileId === host.osnProfileId
              ? {
                  ...h,
                  role: nextRole,
                  runSheetScope: readRunSheetScope(answer?.host?.runSheetScope, "own"),
                }
              : h,
          ),
        ),
      );
      // The checklist's assign popover names each seat with its role.
      invalidateHosts(props.weddingId);
      if (isMe(host)) {
        toast.success(
          `You are now ${anArticleFor(nextRole)} ${ROLE_COPY[nextRole].label.toLowerCase()}.`,
        );
        // Stepping down changes what the whole portal offers this person, not
        // only this row: the parent patches the wedding's role from the API's
        // answer, and every view re-derives its surfaces from that.
        props.onOwnRoleChanged?.(nextRole);
        return;
      }
      toast.success(
        `${label} is now ${anArticleFor(nextRole)} ${ROLE_COPY[nextRole].label.toLowerCase()}.`,
      );
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("Could not change that host's role. Is the API running?");
    } finally {
      setRoleBusyId(null);
    }
  }

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="Co-hosts"
        title="Share this wedding's dashboard"
        description={
          canManage()
            ? "Invite a partner or planner to help. Pick someone from your OSN connections, or add them by handle — everyone joins as a viewer, and an owner sets what they can do from their row. A wedding can have more than one owner, all equal: any of you can change a role or remove someone."
            : "These people help run this wedding. Adding someone, changing a role or removing a seat is an owner's call."
        }
      />

      {/* The count every member sees, as the API reported it. */}
      <Show when={peopleLimit()}>
        {(limit) => (
          <p class="font-body text-text-muted text-ui-sm">
            <span class="text-text">{peopleCountLabel(limit())}</span> on this wedding's plan. The
            first two owners don't count.
          </p>
        )}
      </Show>

      {/* At the limit an owner is told why no one more can join, and offered
          the tier that lifts it. The add form stays only while a second owner
          can still join. */}
      <Show when={canManage() && atLimit() ? peopleLimit() : null}>
        {(limit) => (
          // Focusable, not tabbable: `noticeIfFormGone` moves focus here when
          // an add takes the form away, and the notice is announced then.
          <div ref={limitNotice} tabindex="-1">
            <Notice tone="info" alert={limitJustReached()}>
              <div class="flex flex-col gap-3">
                <p>
                  {peopleLimitMessage(limit())}
                  {canAddSecondOwner()
                    ? " You can still add a second owner: the first two owners don't count."
                    : ""}
                </p>
                <Show when={upgradeTierFor(limit())}>
                  {(tier) => (
                    <div>
                      <Button
                        variant="primary"
                        size="sm"
                        type="button"
                        onClick={() => setOffer(tier())}
                      >
                        Upgrade to {TIER_LABEL[tier()]}
                      </Button>
                    </div>
                  )}
                </Show>
              </div>
            </Notice>
          </div>
        )}
      </Show>

      <Show when={showsAddForm()}>
        <form class="flex flex-col gap-3" onSubmit={add}>
          {/* What each role carries, ahead of the box that names the person.
              Before the handle rather than after it because it is what the
              decision needs: who to add is a different question from what they
              will be able to do, and the second one is answered on their row
              once they are here. */}
          <Fieldset legend="What a co-host can do">
            <dl class="flex flex-col gap-2 @lg/panel:flex-row">
              <For each={grantable()}>
                {(option) => (
                  <div class="border-border bg-bg flex flex-1 flex-col gap-1 rounded-sm border p-3">
                    <dt class="font-body text-text text-ui-base">{ROLE_COPY[option].label}</dt>
                    <dd class="font-body text-text-muted text-ui-sm leading-snug">
                      {ROLE_COPY[option].summary}
                    </dd>
                  </div>
                )}
              </For>
            </dl>
          </Fieldset>

          {/* `Field` owns the label, the id and the error wiring. The message
              sits with the box it is about rather than at the foot of the form,
              which was far enough away that reading the two together took a
              scroll. */}
          <Field label="OSN handle" errors={addErrors()}>
            {(field) => (
              <div class="flex flex-wrap items-center gap-3">
                {/* Combobox: a text input that suggests matching OSN profiles as
                    the organiser types. The manual type-and-submit path is
                    preserved — the dropdown is additive and never required. */}
                <div class="relative min-w-48 flex-1">
                  <UsernameInput
                    {...field}
                    name="osnHandle"
                    value={handle()}
                    maxLength={64}
                    placeholder="alice"
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                    role="combobox"
                    aria-expanded={open()}
                    aria-controls={LISTBOX_ID}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      open() && activeIdx() >= 0 ? optionId(activeIdx()) : undefined
                    }
                    onInput={(e) => onHandleInput(e.currentTarget.value)}
                    onKeyDown={onHandleKeyDown}
                    // Delay close so a click on a suggestion (which blurs the
                    // input) still registers before the list unmounts.
                    onBlur={() => setTimeout(closeSuggestions, 120)}
                    onFocus={() => void onHandleFocus()}
                    disabled={adding()}
                  />
                  <Show when={open() && suggestions().length > 0}>
                    <div class="border-border bg-bg absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-sm border shadow-lg">
                      {/* Caption for the on-focus case only: with nothing typed the
                          list IS the organiser's connections, and saying so is what
                          makes an unprompted dropdown legible rather than startling. */}
                      <Show when={browsingConnections()}>
                        <p class="border-border text-text-muted font-body text-ui-xs tracking-ui-wider border-b px-3 py-2 uppercase">
                          From your OSN connections
                        </p>
                      </Show>
                      <ul
                        id={LISTBOX_ID}
                        role="listbox"
                        aria-label={
                          browsingConnections() ? "Your OSN connections" : "Matching OSN profiles"
                        }
                        class="max-h-60 overflow-auto"
                      >
                        <For each={suggestions()}>
                          {(s, i) => (
                            <li
                              id={optionId(i())}
                              role="option"
                              aria-selected={activeIdx() === i()}
                              // onMouseDown (not click) so the input's onBlur doesn't
                              // close the list before the selection lands.
                              onMouseDown={(e) => {
                                e.preventDefault();
                                pick(s);
                              }}
                              onMouseEnter={() => setActiveIdx(i())}
                              class="flex cursor-pointer flex-col gap-0.5 px-3 py-2 text-left"
                              classList={{
                                "bg-surface": activeIdx() === i(),
                              }}
                            >
                              <span class="flex flex-wrap items-center gap-2">
                                <span class="font-body text-gold-dim text-ui-base">
                                  @{s.handle}
                                </span>
                                {/* Only on the mixed list — when every row is a
                                    connection the caption already said so, and a
                                    badge on every row is noise. */}
                                <Show when={s.connected && !browsingConnections()}>
                                  <span class="border-gold/40 text-gold font-body text-ui-xs tracking-ui-widest rounded-sm border px-1.5 py-0.5 uppercase">
                                    Connected
                                  </span>
                                </Show>
                              </span>
                              <Show when={s.displayName}>
                                <span class="font-body text-text-muted text-ui-sm">
                                  {s.displayName}
                                </span>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </Show>
                </div>
                <Button type="submit" variant="primary" disabled={adding()}>
                  {adding() ? "Adding…" : canAddSecondOwner() ? "Add as owner" : "Add host"}
                </Button>
              </div>
            )}
          </Field>
        </form>
      </Show>

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2]}>{() => <div class="bg-surface h-13 animate-pulse rounded-sm" />}</For>
        </div>
      </Show>

      <Show when={error()}>
        <Notice tone="danger" alert>
          {error()}
        </Notice>
      </Show>

      <Show when={!loading() && !error()}>
        {/* Never let a truncated list look complete: a seat that isn't shown is
            a seat the owner can't remove, and every seat can read the household
            claim codes and the dietary export. */}
        <Show when={truncated()}>
          <Notice tone="danger" alert>
            Showing {hosts().length} of {total()} co-hosts. Contact support — some seats on this
            wedding aren&apos;t listed here and can&apos;t be removed from this screen.
          </Notice>
        </Show>
        <Show when={hosts().length > 0}>
          <ul class="flex flex-col gap-2">
            <For each={hosts()}>
              {(host) => (
                // Wraps, so a helper's run-sheet line takes a line of its own
                // under the name and the controls: at phone width there is no
                // room beside them for a second select at its full width.
                <li
                  class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-sm border px-4 py-3"
                  classList={{
                    "border-gold/40 bg-gold/5": host.role === "owner",
                    "border-border bg-surface/30": host.role !== "owner",
                  }}
                >
                  <span class="font-body text-text text-ui-base flex flex-wrap items-center gap-3">
                    {host.handle ? (
                      <span class="text-gold-dim">@{host.handle}</span>
                    ) : (
                      <span
                        class="text-text-muted text-ui-sm tracking-ui-wide font-mono"
                        title="OSN profile id"
                      >
                        {host.osnProfileId}
                      </span>
                    )}
                    <Show when={isMe(host)}>
                      <span class="font-body text-text-muted text-ui-xs tracking-ui-wide">you</span>
                    </Show>
                    {/* The badge is the read of the seat. An owner also gets the
                        select below, which is the write — both name the role
                        from the same place, so they cannot disagree. */}
                    <span
                      class="text-gold font-body text-ui-xs tracking-ui-widest rounded-sm border px-2 py-0.5 uppercase"
                      classList={{
                        "border-gold": host.role === "owner",
                        "border-gold/40": host.role !== "owner",
                      }}
                      title={ROLE_COPY[host.role].summary}
                    >
                      {ROLE_COPY[host.role].label}
                    </span>
                    {/* Who seated them. Shown only to owners, and only when the
                        seat names someone other than its holder — owners are
                        equals, so which of them seated someone is worth
                        surfacing. Absent on older API payloads. */}
                    <Show
                      when={
                        canManage() &&
                        host.addedByOsnProfileId &&
                        host.addedByOsnProfileId !== host.osnProfileId &&
                        (host.addedByHandle ?? host.addedByOsnProfileId)
                      }
                    >
                      {(addedBy) => (
                        <span class="font-body text-text-muted text-ui-xs tracking-ui-wide">
                          added by {host.addedByHandle ? `@${host.addedByHandle}` : addedBy()}
                        </span>
                      )}
                    </Show>
                  </span>
                  <Show when={canManage()}>
                    <span class="flex items-center gap-3">
                      {/* The value is the pending promotion's target while one
                          is being confirmed, and the seat's own role otherwise.
                          That is what puts the select back when the dialog is
                          dismissed: the option changed in the DOM the moment it
                          was picked, and only a change to this expression can
                          undo it. */}
                      <Select
                        size="sm"
                        value={pendingRoleFor(host) ?? host.role}
                        disabled={roleBusyId() === host.osnProfileId}
                        aria-label={
                          isMe(host) ? "Your role on this wedding" : `Role for ${nameOf(host)}`
                        }
                        onChange={(e) => selectRole(host, e.currentTarget.value as AssignableRole)}
                      >
                        <For each={grantable()}>
                          {(option) => <option value={option}>{ROLE_COPY[option].label}</option>}
                        </For>
                      </Select>
                      {/* No remove on your own row: stepping down is the select
                          above, and it keeps the wedding's last owner in place. */}
                      <Show when={!isMe(host)}>
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() => void remove(host)}
                          aria-label={`Remove ${host.handle ? `@${host.handle}` : "host"}`}
                        >
                          Remove
                        </Button>
                      </Show>
                    </span>
                  </Show>
                  {/* How far into the run sheet a helper sees: a helper's
                      setting alone, so no other row names one. An owner sets
                      it here; everyone else reads it. A line of its own. */}
                  <Show when={host.role === "helper"}>
                    <Show
                      when={canManage()}
                      fallback={
                        <span class="font-body text-text-muted text-ui-xs tracking-ui-wide basis-full">
                          Sees: {RUN_SHEET_SCOPE_COPY[scopeOf(host)].phrase}
                        </span>
                      }
                    >
                      <label class="font-body text-text-muted text-ui-xs tracking-ui-wide flex basis-full items-center gap-2">
                        Sees:
                        {/* `w-auto`: on a line of its own the control box's full
                            width would run the select across the whole row.
                            `aria-busy`, never `disabled`, while its write is
                            out: see `selectScope`. */}
                        <Select
                          size="sm"
                          class="w-auto"
                          value={scopeShownFor(host)}
                          aria-busy={scopeWrites().has(host) ? "true" : undefined}
                          aria-label={`What ${nameOf(host)} sees on the run sheet`}
                          onChange={(e) => selectScope(host, e.currentTarget)}
                        >
                          <For each={RUN_SHEET_SCOPES}>
                            {(scope) => (
                              <option value={scope}>{RUN_SHEET_SCOPE_COPY[scope].option}</option>
                            )}
                          </For>
                        </Select>
                      </label>
                    </Show>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={!hasCohosts()}>
          <EmptyState
            title="No co-hosts yet"
            description={
              canManage()
                ? "Add one above to share this wedding."
                : "Only the owners manage this wedding for now."
            }
          />
        </Show>
      </Show>

      <Show when={props.canLeave}>
        <LeaveWedding weddingId={props.weddingId} onLeft={props.onLeft} />
      </Show>

      {/* Kept mounted across the close so the exit animates; `shownPromotion`
          is what keeps the person's name on screen through it.

          `onClose` is the single place the pending change is dropped, not the
          Cancel button: the dialog closes on Escape and on a backdrop click
          too, and a revert wired only to Cancel would leave the select showing
          a role nobody granted. */}
      <Modal
        open={pending() !== null}
        onClose={() => setPending(null)}
        label="Confirm this role change"
        class="w-full max-w-md"
      >
        <Show when={shownPromotion()}>
          {(promotion) => (
            <div class="flex flex-col gap-4">
              <Show
                when={promotion().ownSeat}
                fallback={
                  <>
                    <p class="font-display text-text text-ui-md font-light">
                      Make {nameOf(promotion().host)} {anArticleFor(promotion().to)}{" "}
                      {ROLE_COPY[promotion().to].label.toLowerCase()}?
                    </p>
                    <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                      {ROLE_COPY[promotion().to].summary} You can change it back at any time.
                    </p>
                  </>
                }
              >
                <p class="font-display text-text text-ui-md font-light">
                  Step down to {ROLE_COPY[promotion().to].label.toLowerCase()}?
                </p>
                <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                  You will stop being an owner of this wedding. {ROLE_COPY[promotion().to].summary}{" "}
                  Only another owner can make you an owner again.
                </p>
              </Show>
              <div class="flex flex-wrap justify-end gap-2">
                <Button variant="quiet" type="button" onClick={() => setPending(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="button"
                  onClick={() => {
                    // Read from the signal rather than from the held copy above,
                    // which survives the close for the exit animation and so is
                    // no longer what is pending by the time this runs.
                    const confirmed = pending();
                    setPending(null);
                    if (confirmed) void changeRole(confirmed.host, confirmed.to);
                  }}
                >
                  {promotion().ownSeat
                    ? "Yes, step down"
                    : `Yes, make them ${ROLE_COPY[promotion().to].label.toLowerCase()}`}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Modal>

      {/* Opening a helper's run sheet to every task. Dropped in `onClose`
          alone, for the reason the promotion dialog's is. */}
      <Modal
        open={pendingScope() !== null}
        onClose={() => setPendingScope(null)}
        label="Confirm showing the whole run sheet"
        class="w-full max-w-md"
      >
        <Show when={shownScope()}>
          {(helper) => (
            <div class="flex flex-col gap-4">
              <p class="font-display text-text text-ui-md font-light">
                Show {nameOf(helper())} the whole run sheet?
              </p>
              <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                They will see every task for the day and who is doing each one, not only their own.
                They still won't see the guest list, the budget or the replies. You can change it
                back at any time.
              </p>
              <div class="flex flex-wrap justify-end gap-2">
                <Button variant="quiet" type="button" onClick={() => setPendingScope(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="button"
                  onClick={() => {
                    // The signal, not the held copy, as for a promotion above.
                    const confirmed = pendingScope();
                    setPendingScope(null);
                    if (confirmed) void changeScope(confirmed, "full");
                  }}
                >
                  Yes, show the whole run sheet
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Modal>

      {/* Seating the second owner at the limit: the same question a promotion
          to owner asks, before anything is sent. */}
      <Modal
        open={pendingOwnerAdd() !== null}
        onClose={() => setPendingOwnerAdd(null)}
        label="Confirm adding an owner"
        class="w-full max-w-md"
      >
        <Show when={shownOwnerAdd()}>
          {(name) => (
            <div class="flex flex-col gap-4">
              <p class="font-display text-text text-ui-md font-light">Add @{name()} as an owner?</p>
              <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                {ROLE_COPY.owner.summary} You can change it back at any time.
              </p>
              <div class="flex flex-wrap justify-end gap-2">
                <Button variant="quiet" type="button" onClick={() => setPendingOwnerAdd(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="button"
                  onClick={() => {
                    // The signal, not the held copy, as for a promotion above.
                    const confirmed = pendingOwnerAdd();
                    setPendingOwnerAdd(null);
                    if (confirmed) void submitAdd(confirmed, "owner");
                  }}
                >
                  Yes, add them as an owner
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Modal>

      {/* Mounted afresh for each offer, as the nav mounts it: the dialog keeps
          its own attempt and submit state, which must not outlive a close.
          Stripe sends the owner back to Settings. */}
      <Show when={offer()}>
        {(tier) => (
          <UpgradeDialog
            open
            weddingId={props.weddingId}
            tier={tier()}
            module="settings"
            title={TIER_LABEL[tier()]}
            blurb={`Room for more people on this wedding, and everything else ${TIER_LABEL[tier()]} includes.`}
            onClose={() => setOffer(null)}
          />
        )}
      </Show>
    </div>
  );
}

/** "an" before a vowel, "a" otherwise — the labels are ours, so this only ever
 *  meets the handful of words in `ROLE_COPY`. */
const anArticleFor = (role: AssignableRole) =>
  /^[aeiou]/i.test(ROLE_COPY[role].label) ? "an" : "a";
