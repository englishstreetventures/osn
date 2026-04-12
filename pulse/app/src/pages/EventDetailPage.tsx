import { useAuth } from "@osn/client/solid";
import { A, useParams } from "@solidjs/router";
import { createResource, Show } from "solid-js";

import { AddToCalendarButton } from "../components/AddToCalendarButton";
import { CommsSummary } from "../components/CommsSummary";
import { EventChatPlaceholder } from "../components/EventChatPlaceholder";
import { MapPreview } from "../components/MapPreview";
import { RsvpSection } from "../components/RsvpSection";
import { api } from "../lib/api";
import { apiBaseUrl } from "../lib/rsvps";
import { formatTime, getUserIdFromToken } from "../lib/utils";

interface EventDetail {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  venue: string | null;
  latitude: number | null;
  longitude: number | null;
  category: string | null;
  startTime: string;
  endTime: string | null;
  status: "upcoming" | "ongoing" | "finished" | "cancelled";
  imageUrl: string | null;
  visibility: "public" | "private";
  guestListVisibility: "public" | "connections" | "private";
  joinPolicy: "open" | "guest_list";
  allowInterested: boolean;
  createdByUserId: string;
  createdByName: string | null;
}

const locationLabel = (e: EventDetail) => [e.venue, e.location].filter(Boolean).join(", ") || null;

async function fetchEvent(id: string, token: string | null): Promise<EventDetail | null> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const { data, error } = await api.events({ id }).get({ headers });
  if (error) return null;
  return (data?.event ?? null) as EventDetail | null;
}

export function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const { session } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;
  const currentUserId = () => getUserIdFromToken(accessToken());

  const source = () => ({ id: params.id, token: accessToken() });
  const [event] = createResource(source, ({ id, token }) => fetchEvent(id, token));

  return (
    <main class="mx-auto max-w-xl px-4 py-6">
      <div class="mb-4">
        <A href="/" class="text-primary text-sm hover:underline">
          ← Back to events
        </A>
      </div>

      <Show when={event.loading}>
        <p class="text-muted-foreground py-16 text-center">Loading…</p>
      </Show>

      <Show when={!event.loading && event() === null}>
        <p class="text-destructive py-16 text-center">Event not found.</p>
      </Show>

      <Show when={event()}>
        {(e) => (
          <article class="flex flex-col gap-4">
            {/* Header card */}
            <div class="border-border bg-card overflow-hidden rounded-xl border">
              <Show when={e().imageUrl}>
                <img class="h-56 w-full object-cover" src={e().imageUrl!} alt={e().title} />
              </Show>
              <div class="p-4">
                <div class="mb-2 flex items-center gap-2">
                  <Show when={e().category}>
                    <span class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-semibold tracking-wide uppercase">
                      {e().category}
                    </span>
                  </Show>
                  <span
                    class={`text-xs ${
                      e().status === "ongoing"
                        ? "font-semibold text-green-600"
                        : e().status === "cancelled"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}
                  >
                    {e().status}
                  </span>
                  <Show when={e().visibility === "private"}>
                    <span class="text-muted-foreground text-xs">· Private</span>
                  </Show>
                </div>
                <h1 class="text-foreground mb-1 text-2xl font-bold">{e().title}</h1>
                <p class="text-muted-foreground mb-3 text-sm">
                  {formatTime(e().startTime)}
                  <Show when={e().endTime}>{(end) => <> – {formatTime(end())}</>}</Show>
                </p>
                <Show when={e().createdByName}>
                  {(name) => <p class="text-muted-foreground mb-3 text-xs">Hosted by {name()}</p>}
                </Show>
                <Show when={e().description}>
                  <p class="text-foreground text-sm whitespace-pre-wrap">{e().description}</p>
                </Show>
                <div class="mt-4">
                  <AddToCalendarButton eventId={e().id} apiBaseUrl={apiBaseUrl} />
                </div>
              </div>
            </div>

            {/* Map */}
            <MapPreview
              latitude={e().latitude}
              longitude={e().longitude}
              label={locationLabel(e())}
            />

            {/* RSVPs */}
            <RsvpSection event={e()} accessToken={accessToken()} currentUserId={currentUserId()} />

            {/* Comms */}
            <CommsSummary eventId={e().id} />

            {/* Chat */}
            <EventChatPlaceholder eventId={e().id} />
          </article>
        )}
      </Show>
    </main>
  );
}
