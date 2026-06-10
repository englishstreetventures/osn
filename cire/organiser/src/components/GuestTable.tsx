import { useAuth } from "@osn/client/solid";
import { createSignal, onMount, Show, For, createMemo } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";

interface OrganiserGuestRow {
  publicId: string;
  familyName: string;
  firstName: string;
  lastName: string;
  events: string[];
}

interface FamilyGroup {
  publicId: string;
  familyName: string;
  members: { firstName: string; lastName: string; events: string[] }[];
}

interface GuestTableProps {
  weddingId: string;
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

  const families = createMemo(() => {
    const map = new Map<string, FamilyGroup>();
    for (const guest of guests()) {
      let family = map.get(guest.publicId);
      if (!family) {
        family = {
          publicId: guest.publicId,
          familyName: guest.familyName,
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

  return (
    <div class="flex flex-col gap-8">
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

      <Show when={!loading() && !error()}>
        <p class="font-body text-text-muted text-[0.82rem]">
          {guests().length} guests across {families().length} families
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
                        class="border-border bg-surface/50 font-display text-gold-dim border-b px-4 py-2 text-[1rem] italic"
                      >
                        {family.familyName}
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
