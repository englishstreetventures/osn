import { useAuth } from "@osn/client/solid";
import { createSignal, onMount, Show, For, createMemo } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { downloadBlob } from "../lib/download";
import { buildInviteMessage, copyToClipboard } from "../lib/invite-message";
import SectionIntro from "./SectionIntro";

interface OrganiserGuestRow {
  familyId: string;
  publicId: string;
  familyName: string;
  firstName: string;
  lastName: string;
  events: string[];
  codeSharedAt: number | null;
  firstOpenedAt: number | null;
}

interface FamilyGroup {
  familyId: string;
  publicId: string;
  familyName: string;
  codeSharedAt: number | null;
  firstOpenedAt: number | null;
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

interface GuestTableProps {
  weddingId: string;
  /** Display name of the wedding — used in the copied invite message. */
  weddingName: string;
  /** URL slug of the wedding — the copied invite message links to this wedding's
   *  path on the SSR'd, path-routed guest site (`CIRE_WEB_URL/<slug>`). */
  weddingSlug: string;
}

interface EventRow {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
}

export default function GuestTable(props: GuestTableProps) {
  const { authFetch } = useAuth();
  const [guests, setGuests] = createSignal<OrganiserGuestRow[]>([]);
  const [eventNameById, setEventNameById] = createSignal<Map<string, string>>(new Map());
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  // Optimistic "Sent" state keyed by family public_id — flips the instant a
  // copy succeeds, so the indicator updates without a reload while the
  // best-effort mark-shared POST settles in the background.
  const [sharedNow, setSharedNow] = createSignal<Set<string>>(new Set());
  const [exporting, setExporting] = createSignal(false);

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

  onMount(async () => {
    try {
      const [guestsRes, eventsRes] = await Promise.all([
        authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/guests`)),
        authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/events`)),
      ]);
      if (guestsRes.status === 401 || eventsRes.status === 401) return redirectToLogin();
      if (!guestsRes.ok || !eventsRes.ok) throw new Error("Failed to load");
      const guestData = (await guestsRes.json()) as OrganiserGuestRow[];
      const eventData = (await eventsRes.json()) as EventRow[];
      setGuests(guestData);
      setEventNameById(new Map(eventData.map((e) => [e.id, e.name])));
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
   * Download the wedding's RSVP CSV. The CSV is built (and formula-sanitised)
   * server-side at `GET …/rsvps.csv`; the response Blob is handed to the shared
   * download helper. authFetch attaches the OSN access token — the endpoint is
   * gated by `weddingMember()` so the owner OR a co-host can export.
   */
  async function exportRsvps() {
    if (exporting()) return;
    setExporting(true);
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/rsvps.csv`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      downloadBlob(`cire-rsvps-${props.weddingSlug}.csv`, blob);
      toast.success("RSVP export downloaded");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error("Could not export RSVPs. Try again.");
    } finally {
      setExporting(false);
    }
  }

  async function copyMessage(family: FamilyGroup) {
    const message = buildInviteMessage(props.weddingName, family.publicId, props.weddingSlug);
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
              onClick={() => void exportRsvps()}
              disabled={exporting()}
              class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {exporting() ? "Exporting…" : "Download RSVPs (CSV)"}
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
          <p class="font-display text-gold-dim w-full text-[1.2rem] italic">No guests yet</p>
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
                      <td colspan="3" class="border-border bg-surface/50 border-b px-4 py-2">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                          <span class="font-display text-gold-dim flex items-center gap-2 text-[1rem] italic">
                            {family.familyName}
                            {/* "Opened" (a real guest claim) takes precedence
                                over the copy-only "Sent": when a guest has
                                actually opened the invite, that's the stronger,
                                more honest signal, so we show it instead. */}
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
                          </span>
                          <button
                            type="button"
                            onClick={() => void copyMessage(family)}
                            class="font-body text-text-muted hover:text-gold hover:border-gold border-border rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.1em] uppercase transition-colors"
                          >
                            Copy message
                          </button>
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
