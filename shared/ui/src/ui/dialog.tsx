import { Dialog as KobalteDialog } from "@kobalte/core/dialog";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { clsx } from "clsx";
import {
  onCleanup,
  onMount,
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
 * How the scrim comes and goes, by presentation. As a card it fades on the
 * card's keyframes. Behind a sheet below `md` it fades by an `opacity`
 * transition on the sheet's pace, so it darkens as the sheet rises, or under
 * reduced motion as the sheet fades in, and turns round with it; the sheet's
 * two motion utilities also run keyframes that
 * move nothing, which tell Kobalte how long to keep it mounted
 * (`tokens.css`). Each width sets only its own properties, so neither
 * depends on Tailwind's order of `md:` and `max-md:`.
 */
const DIALOG_SCRIM_MOTION = {
  centred:
    "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0",
  sheet:
    "md:base:data-[expanded]:animate-in md:base:data-[closed]:animate-out md:base:data-[closed]:fade-out-0 md:base:data-[expanded]:fade-in-0 " +
    "max-md:base:data-[expanded]:animate-sheet-in max-md:base:data-[closed]:animate-sheet-out " +
    "max-md:base:data-[closed]:opacity-0 max-md:base:starting:opacity-0",
} satisfies Readonly<Record<"centred" | "sheet", string>>;

/**
 * The veil behind the panel. It paints the contract's scrim role,
 * `--ui-scrim`, which `Modal`'s `::backdrop` reads too, so an app that maps it
 * once gets one backdrop for both; unmapped, it is black at 50%.
 * `presentation` matches the panel's, which `DialogContent` passes on.
 */
const DialogOverlay: Component<
  ComponentProps<"div"> & { presentation?: keyof typeof DIALOG_SCRIM_MOTION }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "presentation"]);
  return (
    <KobalteDialog.Overlay
      class={clsx(
        "base:fixed base:inset-0 base:z-50 base:bg-ui-scrim",
        DIALOG_SCRIM_MOTION[local.presentation ?? "centred"],
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
 *
 * The sheet also moves differently: `DIALOG_MOTION` below.
 */
const DIALOG_PRESENTATION = {
  centred: "",
  sheet:
    "max-md:base:top-auto max-md:base:bottom-0 max-md:base:left-0 " +
    "max-md:base:max-w-none max-md:base:translate-x-0 max-md:base:translate-y-0 " +
    "max-md:base:rounded-t-ui-sheet max-md:base:rounded-b-none " +
    "max-md:base:border-x-0 max-md:base:border-b-0 " +
    "max-md:base:pb-[max(0px,env(safe-area-inset-bottom))]",
} satisfies Readonly<Record<"centred" | "sheet", string>>;

/**
 * How the panel comes and goes, by presentation.
 *
 * `centred` fades and scales on the card's keyframes at every width.
 * `sheet` does the same at `md` and up, where it is the card; below `md` it
 * slides up from its own height below the bottom edge over `--ui-dur-slow`
 * and back down over `--ui-dur-base`, both on `--ui-ease-sheet`, at full
 * opacity and with no scale. The slide is a `transform` transition from
 * `@starting-style` in and to the closed state out, so a sheet closed or
 * reopened part-way turns round from where it is. It is on `transform`, not
 * `translate`: the card's centring and the sheet's reset of it are both on
 * `translate`, so a sheet carried across `md` while open would otherwise fly
 * in from the middle of the screen. Under reduced motion the sheet does not
 * slide: it fades in and out with its scrim, on the same pace, and the card
 * shows and hides at once (`tokens.css`).
 */
const DIALOG_MOTION = {
  centred:
    "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out base:data-[expanded]:zoom-in",
  sheet:
    "md:base:data-[expanded]:animate-in md:base:data-[closed]:animate-out md:base:data-[closed]:fade-out-0 md:base:data-[expanded]:fade-in-0 md:base:data-[closed]:zoom-out md:base:data-[expanded]:zoom-in " +
    "max-md:base:data-[expanded]:animate-sheet-in max-md:base:data-[closed]:animate-sheet-out " +
    "max-md:base:data-[closed]:sheet-hidden max-md:base:starting:sheet-hidden",
} satisfies Readonly<Record<keyof typeof DIALOG_PRESENTATION, string>>;

/**
 * How far focus scrolling keeps a control below the top of the panel: the
 * header's height, which `DialogHeader` measures and writes on the panel, the
 * fade under it (`--ui-scroll-edge-size`, 16px), and 1.5rem more for the
 * label above a field and the gap to it, which also holds the widest focus
 * mark (a field's `ring-2 ring-offset-2`, Musubi's 2px outline 2px off). So a
 * field reached with Shift+Tab arrives with its label clear of the fade. A
 * fixed length in place of the header's height would match only a one-line
 * title.
 */
const DIALOG_SCROLL_PADDING =
  "base:scroll-pt-[calc(var(--ui-dialog-header-height,0px)+var(--ui-scroll-edge-size,1rem)+1.5rem)]";

/**
 * Kobalte's focus trap puts a 1px visually hidden `span` at each end of the
 * panel, absolutely placed where it falls. The last one hangs 1px under the
 * footer, so a body that fits would still scroll 1px, and that pixel would
 * bring in the fade. Pinned to the panel's top, the two take no room.
 */
const DIALOG_FOCUS_TRAP = "[&>[data-focus-trap]]:base:top-0";

/**
 * Keeps a control the focus trap wraps onto in view. Kobalte moves focus from
 * one end of the panel to the other without scrolling (Shift+Tab off the first
 * control lands on the footer's action), so in a panel past its cap the
 * control would hold focus out of sight. Focus that arrives from one of the
 * trap's `span`s scrolls the panel itself, never the page behind it, until the
 * control is inside the panel and below the header, the fade and the label
 * allowance (`DIALOG_SCROLL_PADDING`).
 */
function keepWrappedFocusInView(event: FocusEvent) {
  const panel = event.currentTarget;
  const control = event.target;
  const from = event.relatedTarget;
  if (!(panel instanceof HTMLElement) || !(control instanceof HTMLElement)) return;
  if (!(from instanceof HTMLElement) || !from.hasAttribute("data-focus-trap")) return;
  const box = panel.getBoundingClientRect();
  const top = box.top + panel.clientTop;
  const clear = top + (Number.parseFloat(getComputedStyle(panel).scrollPaddingTop) || 0);
  const bottom = top + panel.clientHeight;
  const rect = control.getBoundingClientRect();
  if (rect.bottom > bottom) panel.scrollTop += rect.bottom - bottom;
  else if (rect.top < clear) panel.scrollTop -= clear - rect.top;
}

/**
 * The panel. Its plane is `--ui-surface`, its shadow the contract's raised
 * elevation, `--ui-elev-2` — the one `Modal`, the raised `Card` and the accent
 * menu cast — so an app that maps it once themes every raised panel.
 *
 * At every width, sheet or card, it is at most 85% of the window tall and
 * scrolls past that, as one box, header and footer included. It names its
 * scroll position (`scroll-edge-timeline`) for the fade under `DialogHeader`,
 * keeps focus clear of that header as it scrolls (`DIALOG_SCROLL_PADDING`),
 * and keeps a control the focus trap wraps onto in view
 * (`keepWrappedFocusInView`).
 */
const DialogContent: ParentComponent<
  ComponentProps<"div"> & { presentation?: keyof typeof DIALOG_PRESENTATION }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "children", "presentation", "onFocusIn"]);
  const presentation = () => local.presentation ?? "centred";
  const onFocusIn = (event: FocusEvent & { currentTarget: HTMLDivElement; target: Element }) => {
    keepWrappedFocusInView(event);
    if (typeof local.onFocusIn === "function") local.onFocusIn(event);
  };
  return (
    <DialogPortal>
      <DialogOverlay presentation={presentation()} />
      <KobalteDialog.Content
        class={clsx(
          "base:bg-ui-surface base:border-ui-hairline base:fixed base:top-1/2 base:left-1/2 base:z-50 base:w-full base:max-w-lg base:-translate-x-1/2 base:-translate-y-1/2 base:rounded-ui-lg base:border base:shadow-[var(--ui-elev-2)] base:focus:outline-none",
          "base:max-h-[85dvh] base:overflow-y-auto base:scroll-edge-timeline",
          DIALOG_SCROLL_PADDING,
          DIALOG_FOCUS_TRAP,
          DIALOG_PRESENTATION[presentation()],
          DIALOG_MOTION[presentation()],
          local.class,
        )}
        onFocusIn={onFocusIn}
        {...others}
      >
        {local.children}
      </KobalteDialog.Content>
    </DialogPortal>
  );
};

/**
 * Where scroll timelines are read, the header draws no line: its edge keeps
 * its 1px, transparent, so it is as tall as with the line, and a 16px fade
 * under it (`scroll-edge-fade`, `tokens.css`) comes in as the body scrolls
 * under it. Elsewhere it keeps the hairline and draws no fade.
 */
const SCROLL_EDGE =
  "supports-[animation-timeline:scroll()]:base:border-b-transparent " +
  "supports-[animation-timeline:scroll()]:base:after:scroll-edge-fade";

/**
 * The dialog's title row. It stays at the top of the panel while a long body
 * scrolls under it, on the panel's own surface, with the scroll edge
 * (`SCROLL_EDGE`) under it. `z-1` keeps a positioned box in the body under it as it passes:
 * by tree order alone the later box would paint over it. Chromium paints a
 * stuck header on top either way; the class is for the engines that follow
 * the order.
 *
 * It writes its height on the panel as `--ui-dialog-header-height`, which the
 * panel's scroll padding reads, so focus never parks a control under it. A
 * title can wrap, so the height is measured, not assumed, by a
 * `ResizeObserver` on the header and the panel. Past a third of the panel's
 * height the row is no longer stuck.
 */
const DialogHeader: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class", "ref"]);
  let header: HTMLDivElement | undefined;
  onMount(() => {
    const row = header;
    const panel = row?.closest<HTMLElement>('[role="dialog"]');
    if (!row || !panel || typeof ResizeObserver === "undefined") return;
    // Layout sizes, which the card's entry scale does not shrink. A row taller
    // than a third of the panel — a title of a thousand characters someone
    // else chose — stops sticking and scrolls away with the body, so it can
    // never cover the dialog's own words and buttons.
    const observer = new ResizeObserver(() => {
      const tall = row.offsetHeight > panel.clientHeight / 3;
      row.style.position = tall ? "static" : "";
      panel.style.setProperty("--ui-dialog-header-height", `${tall ? 0 : row.offsetHeight}px`);
    });
    observer.observe(row);
    observer.observe(panel);
    onCleanup(() => {
      observer.disconnect();
      panel.style.removeProperty("--ui-dialog-header-height");
    });
  });
  return (
    <div
      ref={(el) => {
        header = el;
        if (typeof local.ref === "function") local.ref(el);
      }}
      class={clsx(
        "base:sticky base:top-0 base:z-1 base:bg-ui-surface",
        "base:flex base:items-center base:justify-between base:border-b base:border-ui-hairline base:p-4",
        SCROLL_EDGE,
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
