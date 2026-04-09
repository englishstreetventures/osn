import { Show } from "solid-js";
import { A } from "@solidjs/router";
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
  currentUserId?: string | null;
}) {
  const canDelete = () =>
    !!props.currentUserId && props.event.createdByUserId === props.currentUserId;

  return (
    <div class="rounded-xl border border-border bg-card overflow-hidden">
      {/* The block above the action row is a single navigable link to the
          full event view. We exclude the bottom row (Maps link + Delete
          button) so nested interactive elements don't steal the click. */}
      <A href={`/events/${props.event.id}`} class="block hover:opacity-95">
        <Show when={props.event.imageUrl}>
          <img
            class="w-full h-44 object-cover"
            src={props.event.imageUrl!}
            alt={props.event.title}
          />
        </Show>
        <div class="p-4 pb-0">
          <div class="flex items-center gap-2 mb-2">
            <Show when={props.event.category}>
              <span class="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {props.event.category}
              </span>
            </Show>
            <span
              class={`text-xs ${props.event.status === "ongoing" ? "text-green-600 font-semibold" : props.event.status === "cancelled" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {props.event.status}
            </span>
          </div>
          <h2 class="text-base font-semibold text-foreground mb-1">{props.event.title}</h2>
        </div>
      </A>
      {/* Bottom half — NOT wrapped in the link so nested interactive
          elements (Maps link, Delete button) receive their own clicks. */}
      <div class="p-4 pt-2">
        <Show when={props.event.description}>
          <p class="text-sm text-muted-foreground line-clamp-2 mb-3">{props.event.description}</p>
        </Show>
        <Show when={props.event.createdByName}>
          {(name) => (
            <div class="flex items-center gap-2 mb-3">
              <Show
                when={props.event.createdByAvatar}
                fallback={
                  <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted text-muted-foreground text-[10px] font-semibold shrink-0">
                    {initials(name())}
                  </span>
                }
              >
                {(avatar) => (
                  <img
                    src={avatar()}
                    alt={name()}
                    class="w-6 h-6 rounded-full object-cover shrink-0"
                  />
                )}
              </Show>
              <span class="text-xs text-muted-foreground">Hosted by {name()}</span>
            </div>
          )}
        </Show>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
            <A href={`/events/${props.event.id}`} class="text-xs text-primary hover:underline">
              View details
            </A>
            <Show when={mapsUrl(props.event)}>
              {(url) => (
                <a
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-primary hover:underline"
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
              class="text-xs text-destructive hover:text-destructive/80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {props.deleting ? "Deleting…" : "Delete"}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
