import type { PopoverRootOptions } from "@kobalte/core/popover";

import { Popover, PopoverTrigger, PopoverContent } from "./popover";

interface InfoPopoverProps {
  /** Accessible name for the trigger — the glyph alone announces nothing. */
  label?: string;
  /** The explanation itself. Plain prose; the panel is 15rem wide. */
  body: string;
  /** Character in the circle. `?` asks a question, `i` offers a fact. */
  glyph?: string;
  /**
   * Which side the panel opens on. Kobalte's default is `"bottom"`, which
   * covers whatever sits below the trigger — pass `"top"` where that is a
   * field the reader is about to type into. Popper flips to the opposite
   * side when the chosen one does not fit.
   */
  placement?: PopoverRootOptions["placement"];
}

/**
 * A small circled glyph beside a form label, opening a panel that explains
 * what the field is for.
 *
 * The trigger is a native `<button type="button">`: Enter and Space activate
 * it, and it never submits the form it sits inside. Kobalte owns Escape,
 * outside-click dismissal and focus return.
 */
export function InfoPopover(props: InfoPopoverProps) {
  return (
    <Popover placement={props.placement}>
      <PopoverTrigger
        aria-label={props.label ?? "More info"}
        class="base:bg-muted base:text-muted-foreground base:hover:bg-muted/80 base:focus:ring-ring base:ml-1 base:inline-flex base:h-4 base:w-4 base:items-center base:justify-center base:rounded-full base:text-[10px] base:font-semibold base:focus:ring-2 base:focus:outline-none"
      >
        {props.glyph ?? "?"}
      </PopoverTrigger>
      <PopoverContent onOpenAutoFocus={(e) => e.preventDefault()}>{props.body}</PopoverContent>
    </Popover>
  );
}
