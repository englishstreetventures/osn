import { createResource, For, Show } from "solid-js";
import { fetchCommsSummary } from "../lib/rsvps";

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
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
    <div class="rounded-xl border border-border bg-card p-4">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-semibold text-foreground">Announcements</h3>
        <Show when={data()?.channels}>
          {(channels) => (
            <span class="text-xs text-muted-foreground">via {channels().join(" + ")}</span>
          )}
        </Show>
      </div>
      <Show
        when={(data()?.blasts.length ?? 0) > 0}
        fallback={
          <p class="text-xs text-muted-foreground">
            The organiser hasn't sent any announcements yet.
          </p>
        }
      >
        <ul class="flex flex-col gap-2">
          <For each={data()!.blasts.slice(0, 3)}>
            {(blast) => (
              <li class="text-sm border-l-2 border-primary/40 pl-3">
                <p class="text-foreground whitespace-pre-wrap break-words">{blast.body}</p>
                <p class="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">
                  {blast.channel} · {formatRelative(blast.createdAt)}
                </p>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
