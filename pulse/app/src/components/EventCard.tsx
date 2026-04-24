import { Avatar, AvatarImage, AvatarFallback } from "@osn/ui/ui/avatar";
import { Badge } from "@osn/ui/ui/badge";
import { Card } from "@osn/ui/ui/card";
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
    <Card class="overflow-hidden">
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
              <Badge variant="secondary" class="tracking-wide uppercase">
                {props.event.category}
              </Badge>
            </Show>
            <span
              class={`text-xs ${
                props.event.status === "ongoing"
                  ? "font-semibold text-green-600"
                  : props.event.status === "cancelled"
                    ? "text-destructive"
                    : "text-muted-foreground"
              }`}
            >
              {props.event.status === "maybe_finished" ? "maybe finished" : props.event.status}
            </span>
            <Show when={(props.event as { seriesId?: string | null }).seriesId}>
              <span
                class="text-muted-foreground inline-flex items-center"
                title="Part of a series"
                aria-label="Part of a series"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M17 1l4 4-4 4" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <path d="M7 23l-4-4 4-4" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
              </span>
            </Show>
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
              <Avatar class="h-6 w-6">
                <Show when={props.event.createdByAvatar}>
                  {(avatar) => <AvatarImage src={avatar()} alt={name()} />}
                </Show>
                <AvatarFallback>{initials(name())}</AvatarFallback>
              </Avatar>
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
    </Card>
  );
}
