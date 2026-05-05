import { createSignal, onMount, Show, For, createMemo } from "solid-js";

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
  apiUrl: string;
}

export default function GuestTable(props: GuestTableProps) {
  const [guests, setGuests] = createSignal<OrganiserGuestRow[]>([]);
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
      const res = await fetch(`${props.apiUrl}/api/organiser/guests`);
      if (!res.ok) throw new Error("Failed to load");
      const data = (await res.json()) as OrganiserGuestRow[];
      setGuests(data);
    } catch {
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
            {() => <div class="h-[52px] animate-pulse rounded-sm bg-surface" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="rounded-sm border border-error/20 bg-error/5 p-4 text-[0.88rem] text-error">
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error()}>
        <p class="font-body text-[0.82rem] text-text-muted">
          {guests().length} guests across {families().length} families
        </p>

        <div class="overflow-x-auto">
          <table class="w-full border-collapse font-body text-[0.88rem]">
            <thead>
              <tr>
                <th class="whitespace-nowrap border-b border-border px-4 py-3 text-left text-[0.72rem] font-normal uppercase tracking-[0.1em] text-gold">
                  Guest Name
                </th>
                <th class="whitespace-nowrap border-b border-border px-4 py-3 text-left text-[0.72rem] font-normal uppercase tracking-[0.1em] text-gold">
                  Events
                </th>
                <th class="whitespace-nowrap border-b border-border px-4 py-3 text-left text-[0.72rem] font-normal uppercase tracking-[0.1em] text-gold">
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
                        class="border-b border-border bg-surface/50 px-4 py-2 font-display text-[1rem] italic text-gold-dim"
                      >
                        {family.familyName}
                      </td>
                    </tr>
                    <For each={family.members}>
                      {(member, index) => (
                        <tr class="hover:[&>td]:bg-surface">
                          <td class="border-b border-border px-4 py-3 pl-8 align-middle font-normal text-text">
                            {member.firstName} {member.lastName}
                          </td>
                          <td class="border-b border-border px-4 py-3 align-middle">
                            <div class="flex flex-wrap gap-1.5">
                              <For each={member.events}>
                                {(eventId) => (
                                  <span class="inline-block rounded-sm bg-gold/10 px-2 py-0.5 text-[0.72rem] uppercase tracking-[0.06em] text-gold">
                                    {eventId}
                                  </span>
                                )}
                              </For>
                              <Show when={member.events.length === 0}>
                                <span class="text-[0.8rem] text-text-muted">--</span>
                              </Show>
                            </div>
                          </td>
                          <td class="border-b border-border px-4 py-3 align-middle font-mono text-[0.82rem] tracking-[0.06em] text-text-muted">
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
