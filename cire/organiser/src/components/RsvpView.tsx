import { useAuth } from "@osn/client/solid";
import { createSignal, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import SectionIntro from "./SectionIntro";

interface RsvpViewProps {
  weddingId: string;
}

type RsvpStatus = "attending" | "declined" | "maybe";

interface RsvpViewGuest {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
  status: RsvpStatus;
  dietary: string;
}

interface RsvpViewEvent {
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
  guests: RsvpViewGuest[];
}

/** Human label + badge styling per RSVP status. Read-only, so no interaction. */
const STATUS_META: Record<RsvpStatus, { label: string; class: string }> = {
  attending: { label: "Attending", class: "bg-gold text-bg" },
  declined: { label: "Declined", class: "border-error/40 text-error border" },
  maybe: { label: "Maybe", class: "border-gold/40 text-gold border" },
};

/**
 * Read-only in-dashboard RSVP summary. Per event: a status tally (attending /
 * declined / maybe / no response out of invited) and the guests who responded,
 * with their status + dietary notes. Mirrors the data the CSV export reads but
 * shaped by event. The CSV export stays on the Guests tab — this is the at-a-
 * glance view. weddingMember()-gated server-side (owner OR co-host).
 */
export default function RsvpView(props: RsvpViewProps) {
  const { authFetch } = useAuth();
  const [events, setEvents] = createSignal<RsvpViewEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/rsvps`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body = (await res.json()) as { events: RsvpViewEvent[] };
      setEvents(body.events);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load RSVPs. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  const hasEvents = () => events().length > 0;
  // An event the dashboard considers "empty of replies" — no guest has responded
  // yet — gets the inline empty note instead of a table.
  const hasReplies = (event: RsvpViewEvent) => event.guests.length > 0;

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="RSVPs"
        title="Replies at a glance"
        description="Who's coming to each event, with dietary notes — updated as guests reply. Read-only; download the full sheet from the Guests tab."
      />

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3]}>
            {() => <div class="bg-surface h-[120px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error() && !hasEvents()}>
        <div class="border-border bg-surface/30 flex flex-col items-start gap-2 rounded-sm border border-dashed p-8 text-center">
          <p class="font-display text-gold-dim w-full text-[1.2rem] italic">No events yet</p>
          <p class="font-body text-text-muted w-full text-[0.85rem] leading-relaxed">
            Add your events and invite guests — their replies will appear here.
          </p>
        </div>
      </Show>

      <Show when={!loading() && !error() && hasEvents()}>
        <div class="flex flex-col gap-10">
          <For each={events()}>
            {(event) => (
              <section class="border-border bg-surface/30 flex flex-col gap-4 rounded-sm border p-5">
                <header class="flex flex-wrap items-end justify-between gap-3">
                  <h3 class="font-display text-text text-[1.3rem] leading-none font-light italic">
                    {event.name}
                  </h3>
                  {/* The status tally — bounded counts, accessible as plain text. */}
                  <dl class="font-body text-text-muted flex flex-wrap gap-x-4 gap-y-1 text-[0.78rem]">
                    <div class="flex items-center gap-1.5">
                      <dt class="text-gold tracking-[0.08em] uppercase">Attending</dt>
                      <dd class="text-text font-mono">{event.attending}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">Declined</dt>
                      <dd class="text-text font-mono">{event.declined}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">Maybe</dt>
                      <dd class="text-text font-mono">{event.maybe}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">No reply</dt>
                      <dd class="text-text font-mono">{event.noResponse}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">Invited</dt>
                      <dd class="text-text font-mono">{event.invited}</dd>
                    </div>
                  </dl>
                </header>

                <Show
                  when={hasReplies(event)}
                  fallback={
                    <p class="font-body text-text-muted text-[0.82rem] italic">
                      No replies yet for this event.
                    </p>
                  }
                >
                  <div class="overflow-x-auto">
                    <table class="font-body w-full border-collapse text-[0.86rem]">
                      <caption class="sr-only">RSVPs for {event.name}</caption>
                      <thead>
                        <tr>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Guest
                          </th>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Household
                          </th>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Status
                          </th>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Dietary
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={event.guests}>
                          {(guest) => (
                            <tr class="hover:[&>td]:bg-surface">
                              <td class="border-border text-text border-b px-4 py-2.5 align-middle">
                                {guest.firstName} {guest.lastName}
                              </td>
                              <td class="border-border text-text-muted border-b px-4 py-2.5 align-middle">
                                {guest.familyName}
                              </td>
                              <td class="border-border border-b px-4 py-2.5 align-middle">
                                <span
                                  class={`font-body inline-block rounded-sm px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase ${STATUS_META[guest.status].class}`}
                                >
                                  {STATUS_META[guest.status].label}
                                </span>
                              </td>
                              <td class="border-border text-text-muted border-b px-4 py-2.5 align-middle">
                                <Show
                                  when={guest.dietary.trim().length > 0}
                                  fallback={<span class="text-text-muted">--</span>}
                                >
                                  {guest.dietary}
                                </Show>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </section>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
