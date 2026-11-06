import { Card } from "@shared/ui/ui/card";
import { createResource, For, Show } from "solid-js";

import { type DateStyle, zoned } from "../lib/dates";
import { fetchCommsSummary } from "../lib/rsvps";
import { LocalTime } from "./LocalTime";

/**
 * How long ago, from the reader's clock; while the server's text stands, the
 * instant itself, in its zone with the zone named.
 */
function formatRelative(date: Date, style: DateStyle): string {
  if (!style.viewer) {
    return date.toLocaleString(style.locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...zoned(style),
    });
  }
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Renders the configured comms channels and any blasts the organiser
 * has sent. Sits directly above the event chat on the detail page.
 */
export function CommsSummary(props: { eventId: string }) {
  const [data] = createResource(() => props.eventId, fetchCommsSummary);

  return (
    <Card padding="sm">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-foreground text-sm font-semibold">Announcements</h3>
        <Show when={data()?.channels}>
          {(channels) => (
            <span class="text-muted-foreground text-xs">via {channels().join(" + ")}</span>
          )}
        </Show>
      </div>
      <Show
        when={(data()?.blasts.length ?? 0) > 0}
        fallback={
          <p class="text-muted-foreground text-xs">
            The organiser hasn't sent any announcements yet.
          </p>
        }
      >
        <ul class="flex flex-col gap-2">
          <For each={data()!.blasts.slice(0, 3)}>
            {(blast) => (
              <li class="border-primary/40 border-l-2 pl-3 text-sm">
                <p class="text-foreground break-words whitespace-pre-wrap">{blast.body}</p>
                <p class="text-muted-foreground text-ui-xs mt-0.5 tracking-wide uppercase">
                  {blast.channel} · <LocalTime value={blast.createdAt} format={formatRelative} />
                </p>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}
