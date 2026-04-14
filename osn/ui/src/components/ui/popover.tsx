import { Popover as KobaltePopover } from "@kobalte/core/popover";
import { clsx } from "clsx";
import { splitProps, type ComponentProps, type ParentComponent } from "solid-js";

import { bx } from "../../lib/utils";

const Popover = KobaltePopover;
const PopoverTrigger = KobaltePopover.Trigger;
const PopoverAnchor = KobaltePopover.Anchor;
const PopoverClose = KobaltePopover.CloseButton;

const PopoverContent: ParentComponent<
  ComponentProps<"div"> & { onOpenAutoFocus?: (e: Event) => void }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "onOpenAutoFocus"]);
  return (
    <KobaltePopover.Portal>
      <KobaltePopover.Content
        class={clsx(
          bx(
            "bg-popover text-popover-foreground border-border z-50 w-60 rounded-md border p-2 text-xs shadow-md outline-none",
          ),
          bx(
            "data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95",
          ),
          local.class,
        )}
        onOpenAutoFocus={local.onOpenAutoFocus}
        {...others}
      />
    </KobaltePopover.Portal>
  );
};

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent };
