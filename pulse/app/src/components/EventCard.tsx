import { A } from "@solidjs/router";
import { Show } from "solid-js";

import type { EventItem } from "../lib/types";
import { formatTime } from "../lib/utils";

function mapsUrl(event: EventItem): string | null {
  if (event.latitude != null && event.longitude != null) {
    return `https://maps.google.com/?q=${event.latitude},${event.longitude}`;
  }
  const query = [event.venue, event.location].filter(Boolean).join(", ");
  if (query) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return null;
}

/** Derives initials from a display name for avatar fallback rendering. */
function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function EventCard(props: {
  event: EventItem;
  onDelete: (id: string) => void;
  deleting?: boolean;
  currentProfileId?: string | null;
}) {
  const canDelete = () =>
    !!props.currentProfileId && props.event.createdByProfileId === props.currentProfileId;

  return (
    <div class="border-border bg-card overflow-hidden rounded-xl border">
      {/* The block above the action row is a single navigable link to the
          full event view. We exclude the bottom row (Maps link + Delete
          button) so nested interactive elements don't steal the click. */}
      <A href={`/events/${props.event.id}`} class="block hover:opacity-95">
        <Show when={props.event.imageUrl}>
          <img
            class="h-44 w-full object-cover"
            src={props.event.imageUrl!}
            alt={props.event.title}
          />
        </Show>
        <div class="p-4 pb-0">
          <div class="mb-2 flex items-center gap-2">
            <Show when={props.event.category}>
              <span class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-semibold tracking-wide uppercase">
                {props.event.category}
              </span>
            </Show>
            <span
              class={`text-xs ${props.event.status === "ongoing" ? "font-semibold text-green-600" : props.event.status === "cancelled" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {props.event.status}
            </span>
          </div>
          <h2 class="text-foreground mb-1 text-base font-semibold">{props.event.title}</h2>
        </div>
      </A>
      {/* Bottom half — NOT wrapped in the link so nested interactive
          elements (Maps link, Delete button) receive their own clicks. */}
      <div class="p-4 pt-2">
        <Show when={props.event.description}>
          <p class="text-muted-foreground mb-3 line-clamp-2 text-sm">{props.event.description}</p>
        </Show>
        <Show when={props.event.createdByName}>
          {(name) => (
            <div class="mb-3 flex items-center gap-2">
              <Show
                when={props.event.createdByAvatar}
                fallback={
                  <span class="bg-muted text-muted-foreground inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold">
                    {initials(name())}
                  </span>
                }
              >
                {(avatar) => (
                  <img
                    src={avatar()}
                    alt={name()}
                    class="h-6 w-6 shrink-0 rounded-full object-cover"
                  />
                )}
              </Show>
              <span class="text-muted-foreground text-xs">Hosted by {name()}</span>
            </div>
          )}
        </Show>
        <div class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <Show when={props.event.venue}>
            <span>{props.event.venue}</span>
          </Show>
          <Show when={props.event.location}>
            <span>{props.event.location}</span>
          </Show>
          <span>{formatTime(props.event.startTime)}</span>
        </div>
        <div class="mt-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <A href={`/events/${props.event.id}`} class="text-primary text-xs hover:underline">
              View details
            </A>
            <Show when={mapsUrl(props.event)}>
              {(url) => (
                <a
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-primary text-xs hover:underline"
                >
                  Open in Maps
                </a>
              )}
            </Show>
          </div>
          <Show when={canDelete()}>
            <button
              onClick={() => {
                if (confirm(`Delete "${props.event.title}"?`)) props.onDelete(props.event.id);
              }}
              disabled={props.deleting}
              class="text-destructive hover:text-destructive/80 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {props.deleting ? "Deleting…" : "Delete"}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
