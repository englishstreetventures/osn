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
          "base:bg-ui-surface-raised base:text-ui-ink base:border-border base:z-50 base:w-60 base:rounded-ui-md base:border base:p-2 base:text-ui-sm base:shadow-md base:outline-none",
          "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out-95 base:data-[expanded]:zoom-in-95",
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
