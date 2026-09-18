import Button from "@cire/ui/button";
import { UsernameInput } from "@cire/ui/username-input";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field, Fieldset } from "@shared/ui/ui/field";
import { heldWhileClosing, Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { Select } from "@shared/ui/ui/select";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
import {
  ASSIGNABLE_ROLES,
  type AssignableRole,
  asSeatRole,
  needsPromotionConfirmation,
  NEW_SEAT_ROLE,
  ROLE_COPY,
} from "../lib/wedding-roles";
import SectionIntro from "./SectionIntro";

/** The wedding's owner — never a row in `wedding_hosts` (the API always rows
 *  them in separately), so it needs its own shape: no role, no add/remove. */
interface WeddingOwnerRow {
  osnProfileId: string;
  handle?: string;
  displayName?: string;
}

interface HostRow {
  osnProfileId: string;
  /** Present only on a freshly-added host (the add response echoes the handle);
   *  the list endpoint returns ids only, so existing rows show the id. */
  handle?: string;
  role: AssignableRole;
  createdAt: number;
  /** Who created this seat. Absent on the add response (it is by definition the
   *  caller) and on a mid-deploy payload from an older API. */
  addedByOsnProfileId?: string;
  /** The adder's handle when the batch lookup resolved it. */
  addedByHandle?: string;
}

/**
 * A role change waiting on the owner to say yes.
 *
 * Held rather than applied because the grant it carries is the widest a seat
 * can be given. While it is held, the row's select shows `to` — the option the
 * owner picked — and dropping this puts the select back on the seat's own role,
 * which is still whatever it was: nothing has been sent.
 */
interface PendingPromotion {
  host: HostRow;
  to: AssignableRole;
}

/** Every row the API hands back, with its role narrowed to one this panel has a
 *  dropdown option for. */
const withSeatRole = (host: HostRow): HostRow => ({ ...host, role: asSeatRole(host.role) });

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
  /** True when the signed-in organiser owns this wedding. Owners can change a
   *  co-host's role and remove one — the subtractive half of host management. */
  canManage: boolean;
  /** True for the owner OR an `editor` co-host — mirrors the API's
   *  `weddingEditor()` gate on `POST /hosts`. Adding is the additive half, and
   *  it is deliberately open wider than removal so the owner isn't the single
   *  person who has to bring everyone on board. */
  canAdd: boolean;
}

/**
 * Hosts section of a wedding's dashboard. Lists the wedding's co-hosts; the
 * owner or an editor can add another organiser by OSN handle, and the owner
 * alone can change a role or remove someone.
 *
 * The two flags are separate because the API's two gates are separate, and the
 * split is additive-versus-subtractive: an editor can grow the team (their
 * ceiling is `editor` — there is no seat above their own to grant), but only
 * the owner can shrink or demote it, so every addition stays reversible by the
 * one person who can't be removed. Offering a button here that the API would
 * 403 is the failure this mirroring avoids.
 */
export default function HostsPanel(props: HostsPanelProps) {
  const { authFetch } = useAuth();
  const [owner, setOwner] = createSignal<WeddingOwnerRow | null>(null);
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
  // True row count from the API; compared against what we rendered.
  const [total, setTotal] = createSignal(0);
  const truncated = () => total() > hosts().length;
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

  const endpoint = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/hosts`);

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

  onMount(async () => {
    try {
      const res = await authFetch(endpoint());
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error("Failed to load");
      const body = (await res.json()) as {
        hosts: HostRow[];
        total?: number;
        owner?: WeddingOwnerRow;
      };
      setOwner(body.owner ?? null);
      setHosts(body.hosts.map(withSeatRole));
      // `total` > the rows we got means the API truncated. Surfaced rather than
      // ignored: an owner shown a partial list has no way to know that someone
      // who can read their guests' data is missing from it.
      setTotal(body.total ?? body.hosts.length);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load hosts. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  async function add(e: Event) {
    e.preventDefault();
    const value = handle().trim();
    if (!value) {
      setAddError("Enter an OSN handle, like @alice.");
      return;
    }
    setAddError(null);
    setAdding(true);
    closeSuggestions();
    try {
      const res = await authFetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sent rather than left to the API's own default, so the seat this
        // panel creates is the one it shows in the row's dropdown a moment
        // later whatever version of the API answered.
        body: JSON.stringify({ handle: `@${value}`, role: NEW_SEAT_ROLE }),
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 404) {
        haptic("reject");
        setAddError(`No OSN account found for @${value}.`);
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        haptic("reject");
        setAddError(
          body.error === "owner_is_host"
            ? "You already host this wedding as its owner."
            : "That person is already a host.",
        );
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
      const body = (await res.json()) as { host: HostRow };
      const added = withSeatRole(body.host);
      setHosts((prev) => [...prev, added]);
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
        toast.error("Could not remove that host. Please try again.");
        return;
      }
      setHosts((prev) => prev.filter((h) => h.osnProfileId !== host.osnProfileId));
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
    if (needsPromotionConfirmation(host.role, nextRole)) {
      setPending({ host, to: nextRole });
      return;
    }
    void changeRole(host, nextRole);
  }

  /** Set a host's role (owner-only; the API re-checks). */
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
        toast.error("Could not change that host's role. Please try again.");
        return;
      }
      setHosts((prev) =>
        prev.map((h) => (h.osnProfileId === host.osnProfileId ? { ...h, role: nextRole } : h)),
      );
      haptic("commit");
      toast.success(`${label} is now a ${ROLE_COPY[nextRole].label.toLowerCase()}.`);
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
          props.canManage
            ? "Invite a partner or planner to help. Pick someone from your OSN connections, or add them by handle — everyone joins as a viewer, and you set what they can do from their row. Only you, the owner, can change a role or remove someone."
            : props.canAdd
              ? "Invite a partner or planner to help — pick someone from your OSN connections, or add them by handle. They join as a viewer; changing a role or removing someone is the owner's call."
              : "These co-hosts help run this wedding. Ask the owner for editor access to add someone."
        }
      />

      <Show when={props.canAdd}>
        <form class="flex flex-col gap-3" onSubmit={add}>
          {/* What each role carries, ahead of the box that names the person.
              Before the handle rather than after it because it is what the
              decision needs: who to add is a different question from what they
              will be able to do, and the second one is answered on their row
              once they are here. */}
          <Fieldset legend="What a co-host can do">
            <dl class="flex flex-col gap-2 @lg/panel:flex-row">
              <For each={ASSIGNABLE_ROLES}>
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
                <div class="relative min-w-[12rem] flex-1">
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
                  {adding() ? "Adding…" : "Add host"}
                </Button>
              </div>
            )}
          </Field>
        </form>
      </Show>

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2]}>
            {() => <div class="bg-surface h-[52px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <Notice tone="danger" alert>
          {error()}
        </Notice>
      </Show>

      <Show when={!loading() && !error()}>
        {/* The owner is never a `wedding_hosts` row (see the API's hosts
            service), so without this the panel below listed every co-host and
            silently left off the one person who can never be removed. Its own
            list, styled apart from the co-hosts below: no role badge to flip,
            no remove control — those actions don't apply to an owner. */}
        <Show when={owner()}>
          {(o) => (
            <ul class="flex flex-col gap-2">
              <li class="border-gold/40 bg-gold/5 flex items-center justify-between gap-4 rounded-sm border px-4 py-3">
                <span class="font-body text-text text-ui-base flex flex-wrap items-center gap-3">
                  {o().handle ? (
                    <span class="text-gold-dim">@{o().handle}</span>
                  ) : (
                    <span
                      class="text-text-muted text-ui-sm tracking-ui-wide font-mono"
                      title="OSN profile id"
                    >
                      {o().osnProfileId}
                    </span>
                  )}
                  <span
                    class="border-gold text-gold font-body text-ui-xs tracking-ui-widest rounded-sm border px-2 py-0.5 uppercase"
                    title="Owns this wedding — can't be removed or demoted"
                  >
                    Owner
                  </span>
                </span>
              </li>
            </ul>
          )}
        </Show>

        {/* Never let a truncated list look complete: a seat that isn't shown is
            a seat the owner can't remove, and every seat can read the household
            claim codes and the dietary export. */}
        <Show when={truncated()}>
          <Notice tone="danger" alert>
            Showing {hosts().length} of {total()} co-hosts. Contact support — some seats on this
            wedding aren&apos;t listed here and can&apos;t be removed from this screen.
          </Notice>
        </Show>
        <Show
          when={hosts().length > 0}
          fallback={
            <EmptyState
              title="No co-hosts yet"
              description={
                props.canAdd
                  ? "Add one above to share this wedding."
                  : "Only the owner manages this wedding for now."
              }
            />
          }
        >
          <ul class="flex flex-col gap-2">
            <For each={hosts()}>
              {(host) => (
                <li class="border-border bg-surface/30 flex items-center justify-between gap-4 rounded-sm border px-4 py-3">
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
                    {/* The badge is the read of the seat. An owner also gets the
                        select below, which is the write — both name the role
                        from the same place, so they cannot disagree. */}
                    <span
                      class="border-gold/40 text-gold font-body text-ui-xs tracking-ui-widest rounded-sm border px-2 py-0.5 uppercase"
                      title={ROLE_COPY[host.role].summary}
                    >
                      {ROLE_COPY[host.role].label}
                    </span>
                    {/* Who seated them. Shown only to the owner, and only when
                        it wasn't the owner's own doing — an editor can create
                        seats now, so a seat the owner didn't create is the thing
                        worth surfacing. Absent on older API payloads. */}
                    <Show
                      when={
                        props.canManage &&
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
                  <Show when={props.canManage}>
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
                        aria-label={`Role for ${nameOf(host)}`}
                        onChange={(e) => selectRole(host, e.currentTarget.value as AssignableRole)}
                      >
                        <For each={ASSIGNABLE_ROLES}>
                          {(option) => <option value={option}>{ROLE_COPY[option].label}</option>}
                        </For>
                      </Select>
                      <Button
                        variant="subtle"
                        size="sm"
                        type="button"
                        onClick={() => void remove(host)}
                        class="transition"
                        aria-label={`Remove ${host.handle ? `@${host.handle}` : "host"}`}
                      >
                        Remove
                      </Button>
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
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
              <p class="font-display text-text text-ui-md font-light">
                Make {nameOf(promotion().host)} {anArticleFor(promotion().to)}{" "}
                {ROLE_COPY[promotion().to].label.toLowerCase()}?
              </p>
              <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                {ROLE_COPY[promotion().to].summary} You can change it back at any time.
              </p>
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
                  Yes, make them {ROLE_COPY[promotion().to].label.toLowerCase()}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Modal>
    </div>
  );
}

/** "an" before a vowel, "a" otherwise — the labels are ours, so this only ever
 *  meets the handful of words in `ROLE_COPY`. */
const anArticleFor = (role: AssignableRole) =>
  /^[aeiou]/i.test(ROLE_COPY[role].label) ? "an" : "a";
