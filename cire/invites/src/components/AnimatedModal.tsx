import { Modal } from "@shared/ui/ui/modal";
import { createSignal, onCleanup, onMount, type JSX } from "solid-js";

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
   * up over the content instead of extending it down (see RsvpModal).
   */
  flushBottom?: boolean;
  children: JSX.Element;
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
 * Four things the platform does not do, each the reason a line below exists.
 *
 * The **theme variables**, which have to be re-declared on the panel because it
 * paints outside the themed section wrapper it belongs to, and are filtered
 * through the allow-list so the prop cannot become a style sink.
 *
 * The **body scroll lock**. A modal dialog makes the page behind it inert — it
 * cannot be clicked or tabbed into — but inert is not unscrollable, and a sheet
 * that slides while the invite scrolls behind it reads as broken.
 *
 * The **frame/scrollport split**. The close button is a sibling of the scroller
 * rather than a child, so it cannot leave the viewport on a sheet tall enough
 * to scroll; that is what {@link Modal}'s `frame` exists for.
 *
 * And the **initial focus**, which goes to the scrollport rather than to the
 * close button. Left alone, `showModal()` focuses the first focusable thing,
 * which is the button — a sibling of the scrollport, so the keyboard is left
 * with nothing to scroll: its nearest scrollable ancestor is the frame, then a
 * `<body>` this component has deliberately locked. Measured with focus on the
 * button, Arrow and PageDown moved a scrollable sheet 0px; with focus on the
 * scrollport, ArrowDown 0→40px and PageDown 40→594px. `autofocus` on the
 * scrollport is how that is said to the platform — the dialog's own focusing
 * steps prefer it over the first tabbable descendant, so there is no imperative
 * `focus()` racing `showModal()` for the same frame.
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

  onMount(() => {
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = previousBodyOverflow;
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
      // The 480px cap rides here rather than in `class` because
      // `shadcn/no-restyle` classifies a call-site class with its own grammar,
      // and that grammar models `max-w-*` only on Tailwind's built-in steps —
      // it rejects `max-w-column-md` outright, even though the plugin can see
      // the class and `no-unknown-classes` is silent on it. Every built-in step
      // is rem, and rem is the one thing this cap must not be: the app steps its
      // root font-size to 17px at 1024px, which would make a 480px panel 510px
      // on a laptop.
      style={{ "max-width": "var(--container-column-md)", ...filterThemeVars(props.themeVars) }}
      // Plain utilities, not `base:`-prefixed ones, for everything that
      // overrides a `Modal` default. `base:` compiles to `:where(&)`, which has
      // zero specificity by design — so a `base:` class here would tie with the
      // component's own and be resolved by Tailwind's stylesheet order rather
      // than by this file. A plain utility simply wins. `md:mb-8` is exactly
      // that: it lifts the centred desktop panel off the viewport floor, and
      // has to beat the presentation's own `md:m-auto`.
      class="md:mb-8"
    >
      {/* No z-index: a positioned box already paints over its non-positioned
          in-flow siblings, so this stays above the scroller without adding a
          magic number. `bg-surface` (not transparent) because content passes
          UNDERNEATH the button as it scrolls, and an opaque chip is what keeps
          a guest's name from colliding with the glyph. */}
      <button
        class="text-text-muted hover:text-text focus-visible:ring-gold/60 bg-surface absolute top-2 right-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-none text-2xl leading-none transition-colors focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => setOpen(false)}
        aria-label="Close"
      >
        &times;
      </button>
      {/* `min-h-0` so this flex item may shrink below its content height —
          without it the panel's `max-h` cannot take effect and nothing
          scrolls.

          `tabindex="0"` makes the scrollport itself focusable, which is what
          gives it a keyboard; `autofocus` is what makes `showModal()` land
          there rather than on the close button. See the component doc.

          `scroll-pt-14` (56px) keeps focus-driven scrolling clear of the
          close button's 52px-tall footprint: tabbing BACKWARDS scrolls a
          target to the top of the scrollport, which is exactly where the chip
          sits. */}
      <div
        autofocus
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region MUST be focusable or it has no keyboard (WCAG 2.1.1; axe `scrollable-region-focusable`). This rule and that one disagree by construction on scrollports, and keyboard operability wins: measured, focus elsewhere left Arrow/PageDown moving this sheet 0px.
        tabindex="0"
        class={`min-h-0 scroll-pt-14 overflow-y-auto overscroll-contain px-6 pt-8 ${
          props.flushBottom ? "pb-0" : "pb-[max(2.5rem,env(safe-area-inset-bottom))] md:pb-10"
        }`}
      >
        {props.children}
      </div>
    </Modal>
  );
}
