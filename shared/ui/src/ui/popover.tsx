import { Popover as KobaltePopover } from "@kobalte/core/popover";
import { clsx } from "clsx";
import { splitProps, type ComponentProps, type ParentComponent } from "solid-js";

const Popover = KobaltePopover;
const PopoverTrigger = KobaltePopover.Trigger;
const PopoverAnchor = KobaltePopover.Anchor;
const PopoverClose = KobaltePopover.CloseButton;

/**
 * Where the panel's portal should land.
 *
 * `<body>` normally. But {@link Modal} is `<dialog>` + `showModal()`, and a
 * modal dialog paints in the **top layer**, above every stacking context in the
 * document — so a panel portalled to `<body>` while one is open is unclickable
 * at any `z-index`, this component's `z-50` included. It is still laid out and
 * still announced; a pointer simply lands on the dialog.
 *
 * Promoting the panel into the top layer as well does not fix it: Kobalte
 * positions with `position: absolute`, whose containing block changes once an
 * element is promoted, and the panel ends up painted somewhere the hit test
 * never reaches.
 *
 * Mounting INTO the open dialog does fix it, and is the more honest description
 * of what is happening anyway: a popover opened from inside a modal belongs to
 * that modal. It inherits the dialog's top-layer promotion, keeps Kobalte's
 * positioning intact, and needs nothing from the call site.
 *
 * `dialog:modal` matches only a dialog opened with `showModal()`, so a
 * non-modal `<dialog open>` — which is an ordinary stacking context — is left
 * alone and keeps the `<body>` portal.
 */
function portalMount(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  // The LAST modal dialog in document order, not the first. With two open, the
  // top layer stacks in promotion order and a panel mounted into the earlier
  // one is painted under the later one — the same invisible-and-unclickable
  // failure this function exists to remove, one nesting level up.
  const modals = document.querySelectorAll<HTMLElement>("dialog:modal");
  return modals.item(modals.length - 1) ?? undefined;
}

const PopoverContent: ParentComponent<
  ComponentProps<"div"> & { onOpenAutoFocus?: (e: Event) => void }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "onOpenAutoFocus"]);
  return (
    <KobaltePopover.Portal mount={portalMount()}>
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
