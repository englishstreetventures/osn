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

export function EventCard(props: {
  event: EventItem;
  onDelete: (id: string) => void;
  deleting?: boolean;
}) {
  return (
    <div class="rounded-xl border border-border bg-card overflow-hidden">
      <Show when={props.event.imageUrl}>
        <img class="w-full h-44 object-cover" src={props.event.imageUrl!} alt={props.event.title} />
      </Show>
      <div class="p-4">
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
        <Show when={props.event.description}>
          <p class="text-sm text-muted-foreground line-clamp-2 mb-3">{props.event.description}</p>
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
        <div class="mt-3 flex items-center justify-between">
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
          <button
            onClick={() => {
              if (confirm(`Delete "${props.event.title}"?`)) props.onDelete(props.event.id);
            }}
            disabled={props.deleting}
            class="text-xs text-destructive hover:text-destructive/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {props.deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
