import Button from "@cire/ui/button";
import { Modal } from "@shared/ui/ui/modal";
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";

import { filterThemeVars } from "./invite-theme";

interface AnimatedModalProps {
  onClose: () => void;
  /**
   * `id` of the element that names this dialog (its title). Wired to
   * `aria-labelledby` so the dialog announces with its heading. Consumers
   * should point this at their existing title element.
   */
  labelledBy?: string;
  /** Fallback accessible name when there is no on-screen title to reference. */
  label?: string;
  /**
   * Validated theme CSS-variable map (usually a `sectionVars(...)` from
   * `invite-theme.ts`), applied to the panel so the modal follows its owning
   * section's theme. The modal paints outside any themed section wrapper, so
   * the variables must be re-declared here to reach its contents. Empty/absent
   * ⇒ the built-in tokens, unchanged. Keys are filtered through the
   * theme-variable allow-list (`filterThemeVars`) before touching the DOM, so
   * this prop can never become an arbitrary inline-style sink.
   */
  themeVars?: Record<string, string>;
  /**
   * Drop the panel's own bottom padding so a child can own the sheet's bottom
   * edge — used by a full-bleed sticky action bar, which supplies its own
   * safe-area padding. Without this the bar would either float above the
   * panel's padding or have to cancel it with a negative margin, which
   * `position: sticky` resolves against the scrollport and so hoists the bar
   * up over the content instead of extending it down (see RsvpPanel).
   */
  flushBottom?: boolean;
  /**
   * Receives the scrollport — the element that scrolls the sheet's content.
   * For a caller that changes what the sheet shows and must put the reader
   * back at the top of it (EventSheet, switching panels).
   */
  scrollRef?: (el: HTMLDivElement) => void;
  /**
   * A control drawn in the toolbar's bar, between the title and the close
   * button, so it stays put while the content scrolls under it — EventSheet's
   * badge to its other panel. Absent ⇒ the title and the close button alone.
   * Only drawn with {@link toolbar}.
   */
  action?: JSX.Element;
  /**
   * The sheet's title, at the start of the toolbar's bar, in the room the
   * action and the close button leave it. It may wrap onto several lines, and
   * the bar grows to hold it. The caller owns the heading element, its `id`
   * (for {@link labelledBy}), its wrapping and its focus. Only drawn with
   * {@link toolbar}.
   */
  title?: JSX.Element;
  /**
   * Draw a bar at the top of the sheet — {@link title}, {@link action}, then
   * the close button — that stays put, frosted, while the content scrolls
   * under it. Set for the sheet's whole life rather than only while the
   * action shows: an action withdrawn mid-visit (EventSheet's past a deadline)
   * must not move the content. Without it, the close button alone sits in the
   * corner, outside the scrollport.
   */
  toolbar?: boolean;
  children: JSX.Element;
}

/**
 * The sheet's ×: `Button`'s `round` at `lg`, 44px for touch, on the surface
 * fill wherever it sits, because content passes underneath it as the sheet
 * scrolls, in the corner and on the frosted bar alike.
 */
function CloseButton(props: { onClick: () => void }) {
  return (
    <Button variant="round" size="lg" aria-label="Close" onClick={() => props.onClick()}>
      <span aria-hidden="true">&times;</span>
    </Button>
  );
}

/**
 * The guest site's bottom-sheet modal: the invite's own theming and chrome
 * around `@shared/ui`'s {@link Modal}.
 *
 * ## What the platform owns
 *
 * Everything an overlay usually hand-rolls. `showModal()` supplies the top
 * layer, the focus trap, Escape, the backdrop and the focus restore, and
 * `Modal` supplies the entry and exit choreography as CSS — so there is no
 * animation chunk to import and nothing here to prefetch.
 *
 * ## What is this component's
 *
 * Six things the platform does not do, each the reason a line below exists.
 *
 * The **one height**. The sheet's height is set by the viewport alone — 70% of
 * a phone's, and from `md` 85% of the window up to 640px — whatever it holds,
 * and its content scrolls inside. EventSheet swaps two panels of different
 * heights in it, and a form that grows as the guest answers; a sheet sized to
 * its content would move its edge on every switch and every answer. The
 * scrollport fills the sheet, so a child can end on the sheet's bottom edge
 * however short it is.
 *
 * The **theme variables**, which have to be re-declared on the panel because it
 * paints outside the themed section wrapper it belongs to, and are filtered
 * through the allow-list so the prop cannot become a style sink.
 *
 * The **page scroll lock**. A modal dialog makes the page behind it inert — it
 * cannot be clicked or tabbed into — but inert is not unscrollable, and a sheet
 * that slides while the invite scrolls behind it reads as broken. The lock is
 * on the root element, not `<body>`: the invite gives `<html>` an
 * `overflow-x: clip` (`global.css`), and a root whose overflow is not
 * `visible` keeps the body's value from reaching the viewport, so a body lock
 * styles the body box and leaves the page free to scroll under a wheel or a
 * touch on the sheet's chrome or backdrop. Locking takes a classic scrollbar
 * away, so a page showing one — a window wider than its root — gets
 * `scrollbar-gutter: stable` for as long as the lock holds, and keeps its
 * width; a page showing none gets no gutter. On a short invite with classic
 * scrollbars a gutter would only narrow it, and an overlay scrollbar (a
 * phone's) has no gutter to reserve. The root also takes
 * `overscroll-behavior: none`, so a drag that reaches the end of the sheet's
 * own scroll neither chains into the page nor rubber-bands it, where an
 * engine would do either. All three are put back as the sheet closes.
 *
 * The **frame/scrollport split**. {@link Modal}'s `frame` makes the panel a
 * box that never scrolls, so the scrollport inside it is the only thing that
 * does. Without a toolbar the close button is the scroller's sibling, so it
 * cannot leave the viewport on a sheet tall enough to scroll.
 *
 * The **bar**, under a toolbar. A `sticky` row at the top of the scrollport
 * holding the title, the action and the close button: the content scrolls
 * under it rather than past it, so it is frosted — a translucent fill of the
 * sheet's own surface over a blur of whatever is beneath — behind the title,
 * while the action and the cross keep opaque fills of their own. It is the
 * scrollport's first child, not a sibling, because a sticky box stays put
 * only over the box that scrolls it; it takes its own height in flow, so the
 * content starts below it at rest. That height is at least 3.75rem and grows
 * with a title that wraps, so the scrollport's `scroll-padding-top` follows
 * it: a `ResizeObserver` writes the bar's height to `--sheet-bar` on the
 * scrollport, and focus scrolling never parks a control under it, however
 * many lines the title takes. Full-bleed, it runs the scrollport's width; the
 * scrollbar runs the scrollport's height beside it.
 *
 * And the **initial focus**, which goes to the scrollport rather than to a
 * control. Without a toolbar, `showModal()` left alone focuses the first
 * focusable thing, which is the close button — a sibling of the scrollport, so
 * the keyboard is left with nothing to scroll: its nearest scrollable ancestor
 * is the frame, then a page this component has deliberately locked. Measured
 * with focus on the button, Arrow and PageDown moved a scrollable sheet 0px;
 * with focus on the scrollport, ArrowDown 0→40px and PageDown 40→594px.
 * `autofocus` on the scrollport is how that is said to the platform — the
 * dialog's own focusing steps prefer it over the first tabbable descendant, so
 * there is no imperative `focus()` racing `showModal()` for the same frame.
 * Under a toolbar the bar's controls are inside the scrollport, first in the
 * Tab order after it.
 */
export function AnimatedModal(props: AnimatedModalProps) {
  /**
   * The dialog's own open state, separate from whether this component is
   * mounted.
   *
   * Every consumer mounts this inside a `<Show>` and closes it by clearing the
   * signal that `<Show>` reads, so the component is unmounted the moment the
   * caller hears about a close. `Modal` needs the element to stay in the
   * document while its exit runs, and this is what buys that time: the close
   * button flips this to false, `Modal` plays the exit and fires `onClose` when
   * it has finished, and only then does the caller unmount us. A close the
   * platform performs — Escape, a backdrop click — arrives the same way,
   * without the exit, because the element is already gone from the top layer by
   * the time anything hears about it.
   */
  const [open, setOpen] = createSignal(true);

  let scroller: HTMLDivElement | undefined;
  let bar: HTMLDivElement | undefined;

  // The bar's own height, border included, as the scrollport's scroll padding
  // (see the component doc). The border box's layout size, which the sheet's
  // entry scale does not shrink, and fractional, where `offsetHeight` would
  // round it. Before the first observation, and in an engine with no
  // `ResizeObserver`, the padding falls back to the bar's 3.75rem floor; the
  // first callback lands before the first paint.
  onMount(() => {
    if (!bar || !scroller || typeof ResizeObserver === "undefined") return;
    const port = scroller;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize;
      if (height !== undefined) port.style.setProperty("--sheet-bar", `${height}px`);
    });
    observer.observe(bar, { box: "border-box" });
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    const previousGutter = root.style.scrollbarGutter;
    const previousOverscroll = root.style.overscrollBehavior;
    // Read before the lock, which takes the scrollbar away: a window wider
    // than its root is one showing a classic (non-overlay) scrollbar.
    const showsScrollbar = window.innerWidth > root.clientWidth;
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    // `hidden` takes that scrollbar away; a gutter of the same width keeps the
    // invite behind the sheet from shifting sideways as it opens and closes.
    // Only for a page that shows one, and only while locked: on a short invite
    // with no scrollbar to give back, the gutter would itself narrow the page
    // as the sheet opens.
    if (showsScrollbar) root.style.scrollbarGutter = "stable";
    onCleanup(() => {
      root.style.overflow = previousOverflow;
      root.style.scrollbarGutter = previousGutter;
      root.style.overscrollBehavior = previousOverscroll;
    });
  });

  return (
    <Modal
      open={open()}
      onClose={() => {
        setOpen(false);
        props.onClose();
      }}
      label={props.label}
      labelledBy={props.labelledBy}
      frame
      // Bottom-anchored on a phone, centred above `md`, with the grip radius
      // the invite's own `--ui-radius-sheet` sets. One choice rather than eight
      // margin, radius and max-height utilities, because those only mean
      // anything together: square the bottom corners without the bottom anchor
      // and the result is a centred card with a corner missing.
      presentation="sheet"
      style={filterThemeVars(props.themeVars)}
      // Plain utilities, not `base:`-prefixed ones, for everything that
      // overrides a `Modal` default. `base:` compiles to `:where(&)`, which has
      // zero specificity by design — so a `base:` class here would tie with the
      // component's own and be resolved by Tailwind's stylesheet order rather
      // than by this file. A plain utility simply wins. `md:mb-8` is exactly
      // that: it lifts the centred desktop panel off the viewport floor, and
      // has to beat the presentation's own `md:m-auto`.
      // `max-w-column-md` is the app's own 480px cap, and it must stay in
      // pixels: `@cire/invites` steps its root font-size to 17px at 1024px, so
      // every rem-based `max-w-*` step — including the contract's `max-w-ui-*`
      // — would render this panel 6.25% wider on a laptop than it is on a
      // phone. The family is named in `no-restyle`'s allow lists because the
      // rule's grammar cannot classify a `max-w-*` built from a custom
      // `--container-*` entry; see wiki/shared/design-tokens.md.
      // One height, whatever the sheet holds (see the component doc), and
      // below the presentation's own `max-h` cap. On a phone it is 70% of the
      // screen: low enough that a sparse event's details do not sit over a
      // tall empty sheet, tall enough for a household of one to answer
      // "Attending" without scrolling (410px of a 591px sheet on a 390×844
      // phone, and still whole at 375×667). From `md` it is
      // the cap, `85vh`, up to 640px, in pixels for the same reason as the
      // width; at 1280px wide the form for one guest answering "Attending"
      // then shows every diet and allergy choice above its bar.
      class="max-w-column-md h-[70dvh] md:mb-8 md:h-[min(85vh,640px)]"
    >
      <Show when={!props.toolbar}>
        {/* `z-10` because tree order alone is not enough. This row is an
            earlier-in-tree positioned sibling of the scroller, so it outranks
            the scroller's NON-positioned contents and nothing else — a
            positioned box further down the sheet paints over it. The dietary
            pills are exactly that (they carry `relative` so their `sr-only`
            inputs resolve inside the pill), and content passes underneath this
            chip as the sheet scrolls, which is what `bg-surface` is for.
            Measured with `elementFromPoint` at the chip's own corner: without
            a z-index the pill answers, with one the chip does.

            Not an entry in `lib/z-index.ts`. That module ranks the DOCUMENT's
            layers against each other and says why a sheet has none: a
            `showModal()` dialog paints in the top layer, above every stacking
            context in the page. This number orders two boxes inside one
            dialog and can never meet those. */}
        <div class="absolute top-2 right-2 z-10 flex items-center gap-1">
          <CloseButton onClick={() => setOpen(false)} />
        </div>
      </Show>
      {/* `flex-1 min-h-0` makes this flex item exactly the sheet's height:
          `flex-1` grows it to fill a sheet taller than its content, and
          `min-h-0` lets it shrink below content taller than the sheet —
          without that, nothing scrolls and the content overflows the sheet.
          It is a column itself so its child can grow to fill it in turn,
          which is how a short RSVP form still ends on the sheet's bottom edge.

          `tabindex="0"` makes the scrollport itself focusable, which is what
          gives it a keyboard; `autofocus` is what makes `showModal()` land
          there rather than on the close button. See the component doc.

          The scroll padding keeps focus-driven scrolling clear of whatever
          sits at the top: tabbing BACKWARDS scrolls a target to the top of
          the scrollport. Under a toolbar that is the bar, whose height the
          observer above writes to `--sheet-bar`, falling back to its
          `min-h-15` floor. Without one it is the close chip's 52px footprint
          (`scroll-pt-14`, 56px), and `pt-8` starts the content below it; the
          bar takes its own room in flow and needs no top padding.

          `[-webkit-tap-highlight-color:transparent]`: iOS flashes grey over
          a tapped element that is focusable or takes pointer events, and this
          scrollport (focusable, for its keyboard) and the panels' swipe rail
          inside it (bound to the pointer) are each the size of the sheet. The
          property is inherited, so this covers everything the sheet holds. */}
      <div
        ref={(el) => {
          scroller = el;
          props.scrollRef?.(el);
        }}
        autofocus
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region MUST be focusable or it has no keyboard (WCAG 2.1.1; axe `scrollable-region-focusable`). This rule and that one disagree by construction on scrollports, and keyboard operability wins: measured, focus elsewhere left Arrow/PageDown moving this sheet 0px.
        tabindex="0"
        class={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 [-webkit-tap-highlight-color:transparent] ${
          props.toolbar ? "scroll-pt-[var(--sheet-bar,3.75rem)]" : "scroll-pt-14 pt-8"
        } ${props.flushBottom ? "pb-0" : "pb-[max(2.5rem,env(safe-area-inset-bottom))] md:pb-10"}`}
      >
        <Show when={props.toolbar}>
          {/* The bar: see the component doc. `sticky top-0` over the
              scrollport, which has no top padding to hold it off the edge;
              `-mx-6` cancels the scrollport's sides, and `pl-6` puts the title
              on the content's own 24px edge while `pr-2` keeps the cross 8px
              in from the sheet's corner, where the chip sits without a bar.
              `min-h-15` is a floor, not a height: a long title wraps rather
              than being cut short, and the bar grows with it, `py-2` keeping
              its lines off the bar's edges; the action and the cross stay
              centred on it. `shrink-0`, or this column would shrink it to its
              content once the panels overflow. `mb-5` is the gap above the
              content at rest.

              Frosted: 75% of the sheet's own surface over a blur of what
              passes under it, which holds the title at 4.5:1 over pure black
              or pure white content on every scheme. The action and the cross
              keep opaque fills of their own (`EventSheet.browser.test.tsx`).
              `z-10` for the same reason as the close chip above: the dietary
              pills are positioned boxes later in the tree, and they scroll
              under this. */}
          <div
            ref={(el) => (bar = el)}
            class="bg-surface/75 border-border/60 sticky top-0 z-10 -mx-6 mb-5 flex min-h-15 shrink-0 items-center gap-1 border-b py-2 pr-2 pl-6 backdrop-blur-md"
          >
            <div class="mr-1 min-w-0 flex-1">{props.title}</div>
            {props.action}
            <CloseButton onClick={() => setOpen(false)} />
          </div>
        </Show>
        {props.children}
      </div>
    </Modal>
  );
}
