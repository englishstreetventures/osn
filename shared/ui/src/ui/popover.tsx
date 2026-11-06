import { Popover as KobaltePopover, type PopoverContentOptions } from "@kobalte/core/popover";
import { clsx } from "clsx";
import { splitProps, type ParentComponent } from "solid-js";

import { portalMount } from "./portal-mount";
import type { SafeProps } from "./props";

const Popover = KobaltePopover;
const PopoverTrigger = KobaltePopover.Trigger;
const PopoverAnchor = KobaltePopover.Anchor;
const PopoverClose = KobaltePopover.CloseButton;

/**
 * How much room the popover keeps around whatever the caller puts in it.
 *
 * `none` is for content that owns the edges itself — a menu of full-width rows,
 * an image, a form with its own footer band — where the default padding leaves
 * a strip of popover surface no row can reach into. `tight` is the same idea
 * one step back: a list whose rows carry their own padding still wants a hair
 * of inset so the first row's hover state does not touch the border.
 */
const POPOVER_PADDING = {
  none: "",
  tight: "base:p-1",
  default: "base:p-2",
} satisfies Readonly<Record<"none" | "tight" | "default", string>>;

/**
 * The panel. `onOpenAutoFocus`, `onCloseAutoFocus` and `onInteractOutside` are
 * Kobalte's, for a popover anchored to something other than its own trigger:
 * the caller then says which presses count as outside and where focus returns.
 */
const PopoverContent: ParentComponent<
  SafeProps<"div"> &
    Pick<PopoverContentOptions, "onOpenAutoFocus" | "onCloseAutoFocus" | "onInteractOutside"> & {
      padding?: keyof typeof POPOVER_PADDING;
    }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "onOpenAutoFocus", "padding"]);
  return (
    <KobaltePopover.Portal mount={portalMount()}>
      <KobaltePopover.Content
        class={clsx(
          "base:bg-ui-surface-raised base:text-ui-ink base:border-ui-hairline base:z-50 base:w-60 base:rounded-ui-md base:border base:text-ui-sm base:shadow-md base:outline-none",
          POPOVER_PADDING[local.padding ?? "default"],
          // Grows from the side it is anchored to: Popper writes the origin
          // for the placement it settled on, flips included.
          "base:origin-(--kb-popper-content-transform-origin) base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out base:data-[expanded]:zoom-in",
          local.class,
        )}
        // A modal dialog marks everything outside itself `aria-hidden`, and
        // this content portals to <body>, so it would be hidden from a screen
        // reader while visible on screen. `data-kb-top-layer` is what exempts
        // a node from that walk. Outside a dialog nothing walks the tree and
        // the attribute does nothing — so it belongs here rather than on each
        // call site that has to remember it.
        data-kb-top-layer=""
        onOpenAutoFocus={local.onOpenAutoFocus}
        {...others}
      />
    </KobaltePopover.Portal>
  );
};

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent };
