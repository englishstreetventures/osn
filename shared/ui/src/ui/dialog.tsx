import { Dialog as KobalteDialog } from "@kobalte/core/dialog";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { clsx } from "clsx";
import {
  splitProps,
  type Component,
  type ComponentProps,
  type JSX,
  type ParentComponent,
  type ValidComponent,
} from "solid-js";

const Dialog = KobalteDialog;
const DialogTrigger = KobalteDialog.Trigger;
/**
 * The close control of a dialog.
 *
 * `treatment` exists because the corner "×" is not a button that happens to
 * hold a multiplication sign — it is a glyph that has to be optically the size
 * of the title beside it, sit on its own baseline rather than a line box, and
 * recede until pointed at. Two products had spelled the same four utilities out
 * on it. `bare` is the default so a dialog whose close control is a real
 * labelled button (`<DialogClose as={Button}>Cancel</DialogClose>`) is unstyled
 * here and styled by that button.
 */
const DIALOG_CLOSE_TREATMENT = {
  bare: "",
  glyph:
    "base:text-ui-ink-secondary base:hover:text-ui-ink base:text-ui-lg base:leading-none " +
    "base:transition-colors",
} satisfies Readonly<Record<"bare" | "glyph", string>>;

/**
 * Polymorphic, because `as={Button}` is the documented way to spell the labelled
 * close control the `bare` treatment exists for. A concrete
 * `ComponentProps<"button">` here would drop Kobalte's `as` from the type while
 * leaving it working at runtime — the prop lands in `others` and Kobalte honours
 * it — so the contract and the behaviour would disagree silently.
 */
type DialogCloseProps<T extends ValidComponent = "button"> = PolymorphicProps<
  T,
  { treatment?: keyof typeof DIALOG_CLOSE_TREATMENT; class?: string; children?: JSX.Element }
>;

function DialogClose<T extends ValidComponent = "button">(props: DialogCloseProps<T>) {
  const [local, others] = splitProps(props as DialogCloseProps, ["class", "treatment"]);
  return (
    <KobalteDialog.CloseButton
      class={clsx(DIALOG_CLOSE_TREATMENT[local.treatment ?? "bare"], local.class)}
      {...others}
    />
  );
}

const DialogPortal: ParentComponent = (props) => {
  return <KobalteDialog.Portal>{props.children}</KobalteDialog.Portal>;
};

/**
 * The veil behind the panel. It paints the contract's scrim role,
 * `--ui-scrim`, which `Modal`'s `::backdrop` reads too, so an app that maps it
 * once gets one backdrop for both; unmapped, it is black at 50%.
 */
const DialogOverlay: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Overlay
      class={clsx(
        "base:fixed base:inset-0 base:z-50 base:bg-ui-scrim base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0",
        local.class,
      )}
      {...others}
    />
  );
};

/**
 * Where the panel sits, and what shape that makes it.
 *
 * `sheet` is the same idea as `Modal`'s, for the Kobalte-backed dialog: below
 * `md` the centred card becomes a bottom sheet — pinned to the bottom edge,
 * full width, square bottom corners at every width up to 767px, its top
 * corners reading `--ui-radius-sheet` — and at `md` and up it is exactly the
 * centred card again. No class on the panel may round its corners at a
 * breakpoint under `md`: Tailwind emits a min-width query after the `max-md`
 * ones, so it would win and round the sheet's bottom corners. The safe-area
 * inset is part of the variant rather than the caller's business, because a
 * panel flush with the bottom edge always has the home indicator drawn over it.
 *
 * A caller that spells this out in classes gets it right on the axis it
 * remembers and wrong on the other two; that is what this replaces.
 */
const DIALOG_PRESENTATION = {
  centred: "",
  sheet:
    "max-md:base:top-auto max-md:base:bottom-0 max-md:base:left-0 max-md:base:max-h-[85dvh] " +
    "max-md:base:max-w-none max-md:base:translate-x-0 max-md:base:translate-y-0 " +
    "max-md:base:overflow-y-auto max-md:base:rounded-t-ui-sheet max-md:base:rounded-b-none " +
    "max-md:base:border-x-0 max-md:base:border-b-0 " +
    "max-md:base:pb-[max(0px,env(safe-area-inset-bottom))]",
} satisfies Readonly<Record<"centred" | "sheet", string>>;

/**
 * The panel. Its plane is `--ui-surface`, its shadow the contract's raised
 * elevation, `--ui-elev-2` — the one `Modal`, the raised `Card` and the accent
 * menu cast — so an app that maps it once themes every raised panel.
 */
const DialogContent: ParentComponent<
  ComponentProps<"div"> & { presentation?: keyof typeof DIALOG_PRESENTATION }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "children", "presentation"]);
  return (
    <DialogPortal>
      <DialogOverlay />
      <KobalteDialog.Content
        class={clsx(
          "base:bg-ui-surface base:border-ui-hairline base:fixed base:top-1/2 base:left-1/2 base:z-50 base:w-full base:max-w-lg base:-translate-x-1/2 base:-translate-y-1/2 base:rounded-ui-lg base:border base:shadow-[var(--ui-elev-2)] base:focus:outline-none",
          DIALOG_PRESENTATION[local.presentation ?? "centred"],
          "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out base:data-[expanded]:zoom-in",
          local.class,
        )}
        {...others}
      >
        {local.children}
      </KobalteDialog.Content>
    </DialogPortal>
  );
};

const DialogHeader: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(
        "base:flex base:items-center base:justify-between base:border-b base:border-ui-hairline base:p-4",
        local.class,
      )}
      {...others}
    />
  );
};

const DialogFooter: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(
        "base:flex base:items-center base:justify-end base:gap-2 base:border-t base:border-ui-hairline base:p-4",
        local.class,
      )}
      {...others}
    />
  );
};

/**
 * The dialog's heading. Its weight is the contract's title weight,
 * `--ui-weight-title` through `font-ui-title`, which falls back to 600, so an
 * app that maps nothing keeps the semibold title it always had.
 */
const DialogTitle: Component<ComponentProps<"h2">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Title
      class={clsx("base:text-ui-ink base:text-ui-md base:font-ui-title", local.class)}
      {...others}
    />
  );
};

const DialogDescription: Component<ComponentProps<"p">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Description
      class={clsx("base:text-ui-ink-secondary base:text-ui-base", local.class)}
      {...others}
    />
  );
};

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
