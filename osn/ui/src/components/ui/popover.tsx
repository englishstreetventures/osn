import { Popover as KobaltePopover } from "@kobalte/core/popover";
import { clsx } from "clsx";
import { splitProps, type ComponentProps, type ParentComponent } from "solid-js";

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
          "base:bg-popover base:text-popover-foreground base:border-border base:z-50 base:w-60 base:rounded-md base:border base:p-2 base:text-xs base:shadow-md base:outline-none",
          "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out-95 base:data-[expanded]:zoom-in-95",
          local.class,
        )}
        onOpenAutoFocus={local.onOpenAutoFocus}
        {...others}
      />
    </KobaltePopover.Portal>
  );
};

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent };
