import { Card } from "@shared/ui/ui/card";

/**
 * Placeholder for the event chat. Zap — OSN's messaging app — has its
 * name and workspace layout pinned (`@zap/app` / `@zap/api` / `@zap/db`)
 * but no code yet; the event-chat integration lands in Zap M2, which is
 * tracked as an open issue. When Zap M2 ships, swap this for the real chat component.
 *
 * Kept as a dedicated component so the swap is localised and the page
 * layout doesn't need to change.
 */
export function EventChatPlaceholder(props: { eventId: string }) {
  return (
    <Card padding="lg" variant="dashed" class="text-center">
      <h3 class="text-foreground mb-1 text-sm font-semibold">Event chat</h3>
      <p class="text-muted-foreground text-xs">
        Chat for this event will live here — powered by <span class="font-semibold">Zap</span>,
        OSN's messaging app.
      </p>
      <p class="text-muted-foreground/70 text-ui-xs mt-1">
        Tracked under Zap M2 · event id <code class="font-mono">{props.eventId}</code>
      </p>
    </Card>
  );
}
