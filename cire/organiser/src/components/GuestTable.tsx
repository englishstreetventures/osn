import { useAuth } from "@osn/client/solid";
import { createSignal, onMount, Show, For, createMemo } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
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
  type OrganiserGuestRow,
} from "../lib/guests-store";
import { buildInviteMessage, copyToClipboard } from "../lib/invite-message";
import SectionIntro from "./SectionIntro";

interface FamilyGroup {
  familyId: string;
  publicId: string;
  familyName: string;
  codeSharedAt: number | null;
  firstOpenedAt: number | null;
  deactivatedAt: number | null;
  members: { firstName: string; lastName: string; events: string[] }[];
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

interface GuestTableProps {
  weddingId: string;
  /** True when the signed-in organiser OWNS this wedding. Claim codes are the
   *  guest credential, so cutting one off (deactivate/reactivate) is owner-only
   *  — the API gates it with weddingOwner(), this just hides the buttons. */
  canManage: boolean;
  /** Display name of the wedding — used in the copied invite message. */
  weddingName: string;
  /** URL slug of the wedding — the copied invite message links to this wedding's
   *  path on the SSR'd, path-routed guest site (`CIRE_WEB_URL/<slug>`). */
  weddingSlug: string;
}

export default function GuestTable(props: GuestTableProps) {
  const { authFetch } = useAuth();
  // Guest rows live in a module-scoped, weddingId-keyed cache (`guests-store`,
  // the P-I3 fetch-lift sibling of `events-store`) so this fetch fires once per
  // wedding and is reused when the module shell unmounts/remounts us on a
  // Guests ↔ Schedule switch. An import apply invalidates the entry.
  const guests = () => guestsAccessor(props.weddingId)() ?? [];
  // The event id→name chip map reads the SHARED events cache instead of a second
  // `/events` fetch (the other half of P-I3): a Schedule visit already populated
  // it, and if not we `ensureEventsLoaded` it once below.
  const eventNameById = createMemo(
    () => new Map((eventsAccessor(props.weddingId)() ?? []).map((e) => [e.id, e.name])),
  );
  // Optional host override for the first line of the copied invite message. Read
  // from the same invite-customisation endpoint the Invite builder writes; `null`
  // ⇒ buildInviteMessage falls back to its default prose.
  const [inviteMessage, setInviteMessage] = createSignal<string | null>(null);
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

  const families = createMemo(() => {
    const map = new Map<string, FamilyGroup>();
    for (const guest of guests()) {
      let family = map.get(guest.publicId);
      if (!family) {
        family = {
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
        firstName: guest.firstName,
        lastName: guest.lastName,
        events: guest.events,
      });
    }
    return Array.from(map.values());
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

  onMount(async () => {
    try {
      // Guests + events both flow through their shared caches (one fetch each per
      // wedding, deduped across module switches — P-I3). Events are needed only
      // for the chip map; a Schedule visit may already have them. The invite
      // message is a light per-mount read (no store — it's tiny + non-essential).
      const [, , inviteRes] = await Promise.all([
        ensureGuestsLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/guests`));
          if (res.status === 401) {
            redirectToLogin();
            throw new Error("unauthenticated");
          }
          if (!res.ok) throw new Error("Failed to load");
          return (await res.json()) as OrganiserGuestRow[];
        }),
        ensureEventsLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/events`));
          if (res.status === 401) {
            redirectToLogin();
            throw new Error("unauthenticated");
          }
          if (!res.ok) throw new Error("Failed to load");
          return (await res.json()) as CachedEventRow[];
        }),
        authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/invite`)),
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
      setLoading(false);
    }
  });

  /** Best-effort: tell the API the family's code was just shared. Never blocks
   *  or surfaces an error to the organiser — the copy already succeeded. */
  function markShared(family: FamilyGroup) {
    setSharedNow((prev) => new Set(prev).add(family.publicId));
    void authFetch(
      apiUrl(`/api/organiser/weddings/${props.weddingId}/families/${family.familyId}/mark-shared`),
      { method: "POST" },
    ).catch(() => {
      // Intentionally swallowed — a missed mark only under-counts the remint
      // warning; the optimistic UI flip stays so the organiser isn't confused.
    });
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
        apiUrl(`/api/organiser/weddings/${props.weddingId}/families/${family.familyId}/${action}`),
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
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/${kind}.csv`));
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

  const hasGuests = () => families().length > 0;

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="Guest list"
        title="Households, invites & RSVPs"
        description="Everyone you're inviting, grouped into households. Copy a household's invite message to send their link and code, and download replies any time."
        actions={
          <Show when={!loading() && !error() && hasGuests()}>
            <button
              type="button"
              onClick={() => void exportCsv("guests")}
              disabled={exporting() !== null}
              class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {exporting() === "guests" ? "Exporting…" : "Download guests (CSV)"}
            </button>
            <button
              type="button"
              onClick={() => void exportCsv("rsvps")}
              disabled={exporting() !== null}
              class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {exporting() === "rsvps" ? "Exporting…" : "Download RSVPs (CSV)"}
            </button>
          </Show>
        }
      />

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3, 4, 5]}>
            {() => <div class="bg-surface h-[52px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error() && !hasGuests()}>
        <div class="border-border bg-surface/30 flex flex-col items-start gap-2 rounded-sm border border-dashed p-8 text-center">
          <p class="font-display text-gold-dim w-full text-[1.2rem]">No guests yet</p>
          <p class="font-body text-text-muted w-full text-[0.85rem] leading-relaxed">
            Import your guests sheet from the Spreadsheet Import above to build the list. Each
            household gets its own code and invite message to share.
          </p>
        </div>
      </Show>

      <Show when={!loading() && !error() && hasGuests()}>
        <p class="font-body text-text-muted text-[0.82rem]">
          {guests().length} {guests().length === 1 ? "guest" : "guests"} across {families().length}{" "}
          {families().length === 1 ? "household" : "households"}
        </p>

        <div class="overflow-x-auto">
          <table class="font-body w-full border-collapse text-[0.88rem]">
            <thead>
              <tr>
                <th class="border-border text-gold border-b px-4 py-3 text-left text-[0.72rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase">
                  Guest Name
                </th>
                <th class="border-border text-gold border-b px-4 py-3 text-left text-[0.72rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase">
                  Events
                </th>
                <th class="border-border text-gold border-b px-4 py-3 text-left text-[0.72rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase">
                  Family Code
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={families()}>
                {(family) => (
                  <>
                    <tr>
                      <td
                        colspan="3"
                        class={`border-border bg-surface/50 border-b px-4 py-2 ${
                          isDeactivated(family) ? "opacity-50" : ""
                        }`}
                      >
                        <div class="flex flex-wrap items-center justify-between gap-3">
                          <span class="font-display text-gold-dim flex items-center gap-2 text-[1rem]">
                            {family.familyName}
                            <Show when={isDeactivated(family)}>
                              <span
                                class="font-body border-error/40 text-error rounded-sm border px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase not-italic"
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
                                      class="font-body text-gold/80 border-gold/30 rounded-sm border px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase not-italic"
                                      title="Sent — you copied this family's invite message"
                                    >
                                      Sent
                                    </span>
                                  </Show>
                                }
                              >
                                <span
                                  class="font-body bg-gold text-bg rounded-sm px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase not-italic"
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
                            <button
                              type="button"
                              onClick={() => void copyMessage(family)}
                              class="font-body text-text-muted hover:text-gold hover:border-gold border-border rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.1em] uppercase transition-colors"
                            >
                              Copy message
                            </button>
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
                                      <button
                                        type="button"
                                        onClick={() => setConfirmingId(family.familyId)}
                                        disabled={togglingId() === family.familyId}
                                        class="font-body text-text-muted hover:text-error hover:border-error/60 border-border rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.1em] uppercase transition-colors disabled:opacity-40"
                                        title="Disable this household's code (e.g. a withdrawn invite). Reversible — their guests and RSVPs are kept."
                                      >
                                        Deactivate
                                      </button>
                                    }
                                  >
                                    <span class="font-body text-text-muted text-[0.7rem] tracking-[0.05em]">
                                      Disable this code?
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => void toggleDeactivated(family, true)}
                                      disabled={togglingId() === family.familyId}
                                      class="border-error bg-error font-body text-bg rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.1em] uppercase transition hover:opacity-90 disabled:opacity-40"
                                    >
                                      {togglingId() === family.familyId
                                        ? "Deactivating…"
                                        : "Confirm"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingId(null)}
                                      disabled={togglingId() === family.familyId}
                                      class="font-body text-text-muted text-[0.7rem] underline-offset-4 hover:underline disabled:opacity-40"
                                    >
                                      Cancel
                                    </button>
                                  </Show>
                                }
                              >
                                <button
                                  type="button"
                                  onClick={() => void toggleDeactivated(family, false)}
                                  disabled={togglingId() === family.familyId}
                                  class="font-body text-gold hover:border-gold border-gold/40 rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.1em] uppercase transition-colors disabled:opacity-40"
                                  title="Re-enable this household's code — their guests and RSVPs were kept."
                                >
                                  {togglingId() === family.familyId
                                    ? "Reactivating…"
                                    : "Reactivate"}
                                </button>
                              </Show>
                            </Show>
                          </div>
                        </div>
                      </td>
                    </tr>
                    <For each={family.members}>
                      {(member, index) => (
                        <tr class="hover:[&>td]:bg-surface">
                          <td class="border-border text-text border-b px-4 py-3 pl-8 align-middle font-normal">
                            {member.firstName} {member.lastName}
                          </td>
                          <td class="border-border border-b px-4 py-3 align-middle">
                            <div class="flex flex-wrap gap-1.5">
                              <For each={member.events}>
                                {(eventId) => (
                                  <span
                                    class="bg-gold/10 text-gold inline-block rounded-sm px-2 py-0.5 text-[0.72rem] tracking-[0.06em] uppercase"
                                    title={eventId}
                                  >
                                    {eventNameById().get(eventId) ?? eventId}
                                  </span>
                                )}
                              </For>
                              <Show when={member.events.length === 0}>
                                <span class="text-text-muted text-[0.8rem]">--</span>
                              </Show>
                            </div>
                          </td>
                          <td class="border-border text-text-muted border-b px-4 py-3 align-middle font-mono text-[0.82rem] tracking-[0.06em]">
                            <Show when={index() === 0}>{family.publicId}</Show>
                          </td>
                        </tr>
                      )}
                    </For>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}
