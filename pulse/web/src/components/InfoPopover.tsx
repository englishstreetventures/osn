import { Popover, PopoverTrigger, PopoverContent } from "@osn/ui/ui/popover";

/**
 * Small "(?)" button that reveals a text tooltip describing what a form
 * field does. Used on the create-event flow so organisers can tell at a
 * glance what "guest list visibility" or "join policy" actually means.
 *
 * Now backed by Kobalte's Popover for proper accessibility, focus
 * management, and outside-click/Escape handling.
 */
export function InfoPopover(props: { label?: string; body: string }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={props.label ?? "More info"}
        class="bg-muted text-muted-foreground hover:bg-muted/80 focus:ring-ring ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold focus:ring-2 focus:outline-none"
      >
        ?
      </PopoverTrigger>
      <PopoverContent onOpenAutoFocus={(e) => e.preventDefault()}>{props.body}</PopoverContent>
    </Popover>
  );
}
