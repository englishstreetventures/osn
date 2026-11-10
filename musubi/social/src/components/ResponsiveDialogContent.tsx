import { DialogContent } from "@shared/ui/ui/dialog";
import { splitProps, type ComponentProps, type ParentComponent } from "solid-js";

/**
 * The desktop card's width cap. It applies at `md` and up only: below `md`
 * the dialog is a sheet as wide as the screen.
 */
const WIDTH = {
  sm: "md:max-w-sm",
  xs: "md:max-w-xs",
} satisfies Readonly<Record<"sm" | "xs", string>>;

type ResponsiveDialogContentProps = Omit<ComponentProps<"div">, "class" | "classList" | "style"> & {
  /** The card's cap at `md` and up: `sm` 384px (the default), `xs` 320px. */
  width?: keyof typeof WIDTH;
  /** Runs as the dialog opens, before Kobalte moves focus into it. */
  onOpenAutoFocus?: (event: Event) => void;
  /**
   * Runs as the dialog closes, before focus goes back to its opener. Call
   * `preventDefault()` after focusing an element yourself.
   */
  onCloseAutoFocus?: (event: Event) => void;
};

/**
 * The app's dialog, in its mobile face.
 *
 * Every dialog in `@musubi/social` is a bottom sheet below `md` and a centred
 * card at `md` and up, so the choice is made here once rather than at each of
 * the six call sites. `DialogContent`'s `presentation` variant is what draws it:
 * the anchor, the squared bottom corners, the `--ui-radius-sheet` grip and the
 * safe-area inset only mean anything together, which is why they are one name
 * rather than a class string a call site can get two-thirds right.
 *
 * The card's width is a prop, and the props take no `class`, `classList` or
 * `style`. The sheet's rules sit behind `base:`, which has no specificity, so
 * a plain `max-w-*` at a call site would cap the sheet as well and leave a
 * phone with a narrow sheet pinned to its left edge. Padding and layout go on
 * the children.
 *
 * Focus goes back to the element that had it when the dialog opened, if that
 * element is still in the page. No app dialog has a `Dialog.Trigger`, so
 * without this Kobalte leaves focus on `<body>`. A caller's `onCloseAutoFocus`
 * runs first, and one that calls `preventDefault()` decides instead.
 */
export const ResponsiveDialogContent: ParentComponent<ResponsiveDialogContentProps> = (props) => {
  const [local, others] = splitProps(props, ["width", "onOpenAutoFocus", "onCloseAutoFocus"]);
  let opener: HTMLElement | null = null;

  function onOpenAutoFocus(event: Event) {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
    local.onOpenAutoFocus?.(event);
  }

  function onCloseAutoFocus(event: Event) {
    const target = opener;
    opener = null;
    local.onCloseAutoFocus?.(event);
    if (event.defaultPrevented || !target?.isConnected) return;
    event.preventDefault();
    target.focus();
  }

  // `DialogContent` passes every prop on to Kobalte's `Dialog.Content`, whose
  // focus hooks these are; its own type names only a `div`'s props.
  const focusHooks = { onOpenAutoFocus, onCloseAutoFocus };
  return (
    <DialogContent
      presentation="sheet"
      class={WIDTH[local.width ?? "sm"]}
      {...focusHooks}
      {...others}
    />
  );
};
