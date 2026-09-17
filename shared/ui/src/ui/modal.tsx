/**
 * A modal dialog, built on the platform's own `<dialog>` element.
 *
 * `showModal()` supplies the focus trap, Escape, background inertness and the
 * `::backdrop`; because the element renders in the top layer it needs no
 * `z-index`, no `position` and no portal, and no ancestor `transform` can
 * capture it. `@shared/ui` also ships a Kobalte-backed `Dialog` — the decision
 * record below says which to reach for.
 *
 * ## Keep it mounted across the close
 *
 * The one thing a caller has to get right. `Modal` animates its exit, and it
 * can only do that while the element is still in the document — so drive
 * {@link ModalProps.open} and leave the component mounted:
 *
 * ```tsx
 * // Right: the modal stays, `open` moves.
 * <Modal open={sheet() !== null} onClose={() => setSheet(null)} label="…">…</Modal>
 *
 * // Wrong: `Show` unmounts the dialog the instant `sheet()` goes null, so the
 * // exit has nothing left to play and the sheet blinks away.
 * <Show when={sheet()}>{(s) => <Modal open onClose={…}>…</Modal>}</Show>
 * ```
 *
 * The wrong form is not broken — it closes, restores focus and leaves nothing
 * inert — it just loses the animation, silently.
 *
 * **The children are not mounted while it is closed.** That falls out of the
 * rule above rather than contradicting it: the `<dialog>` stays, its contents
 * do not. Without it, a modal that is merely *available* renders its body into
 * every page that offers it — which in `cire/host` meant a live invite preview
 * rendering twice, once in the sticky side pane and once inside a closed
 * dialog, competing for the same accessible name. The children mount when
 * `open` goes true and unmount once the exit has finished, so an expensive body
 * costs nothing until it is asked for and is still there to be animated away.
 *
 * @see wiki/decisions/native-dialog-over-kobalte.md
 */

import { clsx } from "clsx";
import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  splitProps,
  type Accessor,
  type ComponentProps,
  type JSX,
} from "solid-js";

export type ModalProps = Omit<ComponentProps<"dialog">, "open" | "onClose" | "children"> & {
  /** Whether the dialog is showing. Reactive — set it false to close. */
  open: boolean;
  /**
   * Called whenever the dialog closes, from any cause: the Escape key, a
   * backdrop click, or a form submit inside it. Treat it as the single place
   * that flips `open` back to false — the element can close itself without
   * asking, so a caller that only clears `open` in its own button handler will
   * fall out of sync with the DOM the first time someone presses Escape.
   */
  onClose: () => void;
  /**
   * The accessible name. Required rather than optional: an unnamed dialog is
   * announced as just "dialog", which tells a screen-reader user that something
   * appeared and nothing about what.
   *
   * Pass `labelledBy` instead when a visible heading already says it, so the two
   * cannot drift.
   */
  label?: string;
  /** `id` of the element naming this dialog — a visible heading, usually. Wins over {@link ModalProps.label}. */
  labelledBy?: string;
  /** Whether clicking the backdrop closes it. Default `true`; turn it off for a dialog with unsaved input. */
  dismissable?: boolean;
  /**
   * The panel is a non-scrolling frame and a child owns the scrollport.
   *
   * The default is the simple shape: the panel itself scrolls and carries the
   * padding. That breaks the moment anything has to stay put while the body
   * moves under it — a close button in the corner, a sticky action bar at the
   * foot — because a child of the scrollport scrolls away with the content, and
   * a `position: sticky` bottom bar resolves its offset against the scrollport
   * rather than its parent. `frame` drops the panel's own padding and overflow
   * so the caller can lay those out itself, and makes it a column flex
   * container, which is what lets the scrolling child shrink under the panel's
   * `max-height` (with its own `min-h-0`).
   */
  frame?: boolean;
  children: JSX.Element;
};

/**
 * The stylesheet `Modal` injects once per document.
 *
 * Two things live here rather than in Tailwind utilities. The backdrop is a
 * `::backdrop` pseudo-element, which cannot be targeted by a class on the
 * element; and the entry/exit choreography needs `@starting-style`, which has
 * no utility form either. Both are scoped to `.ui-modal` rather than to
 * `dialog` so an app's own `<dialog>` elements are left alone.
 *
 * ## The backdrop mixes the app's ground rather than using black
 *
 * `color-mix` against `--ui-ground-deep`: on a light theme a black scrim reads
 * as a hole punched in the page, and on a dark one it is nearly invisible.
 * Mixing the app's own ground keeps the scrim in the same family as whatever it
 * is dimming.
 *
 * ## Entry is pure CSS. Exit cannot be.
 *
 * Entry is `@starting-style`, which needs no JavaScript at all: the browser
 * takes the from-state at the moment the element is first rendered. Safari has
 * had it since 17.5; older engines simply show the dialog immediately, which is
 * a degradation rather than a broken state.
 *
 * Exit is the part that has to be held open from JavaScript, and it is worth
 * saying exactly why, because the CSS-only answer looks like it should work.
 * `close()` removes the dialog from the top layer *immediately*, so an exit
 * transition has nothing left to paint. The platform's fix is the `overlay`
 * property with `transition-behavior: allow-discrete`, which defers that
 * removal — and `overlay` is **Chrome and Edge only**, unsupported in Safari
 * and Firefox. On the surface this component was built for, cire's guest site,
 * most traffic is mobile Safari, so a CSS-only exit would mean the dialog
 * blinking away for nearly everyone who sees it.
 *
 * So `close()` is deferred in `Modal` instead: it sets `data-closing`, lets
 * these rules run, and calls `close()` once the element's own animations have
 * finished. No `overlay`, no `allow-discrete`, and the same behaviour in every
 * engine.
 *
 * ## The durations are tokens
 *
 * An app that wants different timing sets `--ui-modal-enter` / `--ui-modal-exit`
 * rather than restyling the component. The defaults are cire's existing modal
 * choreography, which is the only hand-rolled one this replaces.
 */
const MODAL_STYLE = `
.ui-modal::backdrop {
  background-color: color-mix(in srgb, var(--ui-ground-deep, #18181b) 72%, transparent);
  opacity: 0;
  transition: opacity var(--ui-modal-exit, 200ms) ease-in;
}
.ui-modal[open]::backdrop {
  opacity: 1;
  transition: opacity var(--ui-modal-enter, 250ms) ease-out;
}
@starting-style {
  .ui-modal[open]::backdrop { opacity: 0; }
}

.ui-modal {
  opacity: 1;
  transform: none;
  transition:
    opacity var(--ui-modal-enter, 250ms) cubic-bezier(0.22, 1, 0.36, 1),
    transform var(--ui-modal-enter, 350ms) cubic-bezier(0.22, 1, 0.36, 1);
}
@starting-style {
  .ui-modal[open] {
    opacity: 0;
    transform: translateY(24px) scale(0.98);
  }
}

/* After \`[open]\` in source order, so it wins on equal specificity. This is the
   state \`Modal\` holds the element in while it waits for the exit to finish. */
.ui-modal[data-closing] {
  opacity: 0;
  transform: translateY(24px) scale(0.98);
  transition:
    opacity var(--ui-modal-exit, 200ms) ease-in,
    transform var(--ui-modal-exit, 200ms) ease-in;
}

/* Near-zero rather than \`none\`: the exit is awaited, and a transition that was
   never started is one there is nothing to wait for. 1ms keeps the code path
   identical and the motion imperceptible. */
@media (prefers-reduced-motion: reduce) {
  .ui-modal,
  .ui-modal[open],
  .ui-modal[data-closing],
  .ui-modal::backdrop,
  .ui-modal[open]::backdrop {
    transition-duration: 1ms;
  }
}
`;

let styleInjected = false;

function injectModalStyle(): void {
  // Once per document, not once per instance: several modals mounted at the
  // same time would otherwise each add an identical rule.
  if (styleInjected || typeof document === "undefined") return;
  const style = document.createElement("style");
  style.dataset.osnModal = "";
  style.textContent = MODAL_STYLE;
  document.head.append(style);
  styleInjected = true;
}

/**
 * Keep the last value a modal's body was built from, so the body survives the
 * modal's own exit.
 *
 * The case: `const [plan, setPlan] = createSignal<Plan | null>(null)`, a modal
 * open when `plan()` is set, and a body that cannot render without it.
 * Confirming sets it null — which closes the modal, correctly, and unmounts the
 * body on the same tick, so what animates away is an empty bordered box.
 *
 * ```tsx
 * const shown = heldWhileClosing(plan);
 * <Modal open={plan() !== null} onClose={() => setPlan(null)} label="…">
 *   <Show when={shown()}>{(p) => <Body plan={p()} />}</Show>
 * </Modal>
 * ```
 *
 * Only needed when the body depends on a value that goes away. A modal whose
 * contents stand on their own needs nothing: `Modal` already holds its children
 * until the exit finishes.
 */
export function heldWhileClosing<T>(
  source: Accessor<T | null | undefined>,
): Accessor<T | undefined> {
  const [held, setHeld] = createSignal<T | undefined>(source() ?? undefined);
  createEffect(() => {
    const value = source();
    // Only ever written forward: a null means "closing", and the point is that
    // the previous value is still there to render while that happens.
    if (value != null) setHeld(() => value);
  });
  return held;
}

export function Modal(props: ModalProps) {
  const [own, rest] = splitProps(props, [
    "open",
    "onClose",
    "label",
    "labelledBy",
    "dismissable",
    "frame",
    "class",
    "children",
  ]);

  let ref: HTMLDialogElement | undefined;

  injectModalStyle();

  /**
   * Which close this component is currently waiting out.
   *
   * A token rather than a boolean, so a reopen during an exit can invalidate
   * the pending close without cancelling anything: the awaiting code compares
   * the token it captured against this one and does nothing if they differ.
   * Without it, opening a dialog again while it is still fading out would let
   * the old close land a moment later and shut the newly-opened dialog.
   */
  let closingToken = 0;

  /**
   * Whether the children should be in the document: open, or still animating
   * out. Separate from `open` because the exit needs a body to animate, and
   * separate from the element's own `.open` because that is DOM state read at
   * effect time rather than something the view can track.
   */
  const [rendered, setRendered] = createSignal(props.open);

  createEffect(() => {
    const dialog = ref;
    if (!dialog) return;

    // `showModal()` on an already-open dialog throws, and `close()` on a closed
    // one is a silent no-op that still fires nothing — so both directions are
    // guarded by the element's own state rather than by tracking our own.
    if (own.open) {
      // Reopening cancels any exit still in flight, and clears the attribute so
      // the entry rules apply to an element that is not still mid-fade.
      closingToken++;
      setRendered(true);
      dialog.removeAttribute("data-closing");
      if (!dialog.open) open(dialog);
    } else if (dialog.open) {
      void closeWhenAnimationsFinish(dialog);
    }
  });

  /**
   * `showModal()` where the environment has it, the `open` attribute where it
   * does not.
   *
   * jsdom implements no part of `<dialog>` — `showModal` is `undefined` there,
   * not merely inert — so calling it unguarded is a `TypeError` that takes the
   * whole render down. That is a test environment rather than a browser, but
   * the same is true of any server render, and a component that throws where it
   * cannot do its best work is worse than one that degrades.
   *
   * The fallback is a non-modal dialog: visible, in the DOM, with its contents
   * reachable, and without the top layer, focus trap or Escape that the method
   * is what provides. Nothing that needs those can be asserted in such an
   * environment anyway, which is why this component's own suite is a browser
   * one.
   */
  function open(dialog: HTMLDialogElement): void {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  /**
   * The other half of {@link open}, and it needs its own guard for the same
   * reason: jsdom gives `<dialog>` an `open` property that reflects the
   * attribute, so `dialog.open` reads true there, while `close()` is missing
   * entirely. Every path that shuts the element goes through here — a bare
   * `ref.close()` in the unmount handler was a `TypeError` that took down the
   * whole test file it was cleaning up after, not just the modal.
   */
  function close(dialog: HTMLDialogElement): void {
    if (typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    // The attribute is only half of what `close()` does. The other half is the
    // `close` event, which is the ONLY thing that tells a caller the dialog
    // shut — so without dispatching it here the fallback closes silently and
    // `open` desyncs, which is the exact failure the listener below exists to
    // prevent.
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }

  /**
   * Close the dialog, but not until whatever is animating it has finished.
   *
   * `close()` removes a dialog from the top layer immediately, so an exit
   * animation has nothing left to paint. The platform's own answer is the
   * `overlay` property with `transition-behavior: allow-discrete`, which defers
   * that removal — and `overlay` is Chrome and Edge only. Deferring the call
   * instead gets the same result in every engine.
   *
   * `getAnimations({ subtree: true })` rather than a `transitionend` listener,
   * and deliberately not tied to CSS: it returns whatever is actually running
   * on the element and its descendants, so an app animating the panel with
   * Motion One or the Web Animations API is waited out exactly the same way as
   * this component's own transitions. That is what keeps the hook
   * animation-library-agnostic without naming a library.
   */
  async function closeWhenAnimationsFinish(dialog: HTMLDialogElement): Promise<void> {
    const token = ++closingToken;
    dialog.setAttribute("data-closing", "");

    // Reading a layout property flushes the pending style change, so the exit
    // transition has actually STARTED by the time we ask what is running. Skip
    // this and `getAnimations()` comes back empty, the dialog closes on the
    // spot, and the animation this whole function exists for never plays.
    void dialog.offsetHeight;

    // Guarded for the same environments `open` and `close` are: jsdom has no
    // Web Animations API at all, so an unguarded call is a `TypeError` on the
    // close path. Nothing is animating there anyway — the element was never in
    // the top layer — so an empty list is the honest answer rather than a
    // fallback.
    const running =
      typeof dialog.getAnimations === "function" ? dialog.getAnimations({ subtree: true }) : [];
    await Promise.allSettled(running.map((a) => a.finished));

    // A reopen, a second close, or an unmount happened while we waited. Any of
    // them owns the element now.
    if (token !== closingToken || !dialog.isConnected) return;

    dialog.removeAttribute("data-closing");
    if (dialog.open) close(dialog);
    setRendered(false);
  }

  createEffect(() => {
    const dialog = ref;
    if (!dialog) return;

    /*
     * `close` is wired here rather than as an `onClose` JSX prop.
     *
     * It does not bubble, and it is not in Solid's delegated-event list, so
     * whether a JSX handler attaches at all depends on framework internals this
     * component should not be betting on. It cost a failing test to find:
     * Escape closed the element, nothing told the caller, and `open` stayed
     * true against a closed dialog — which is exactly the desync the handler
     * exists to prevent, arriving through the handler itself.
     *
     * This fires for every close: the Escape key, `close()`, and a
     * `<form method="dialog">` submit inside it.
     */
    const handleClose = () => own.onClose();
    dialog.addEventListener("close", handleClose);
    onCleanup(() => dialog.removeEventListener("close", handleClose));
  });

  onCleanup(() => {
    // A dialog unmounted while open leaves the document inert — every click
    // outside it swallowed, with nothing visible to explain why. This closes
    // straight away rather than waiting out an exit: there is nothing left to
    // animate on an element that is about to be removed, and `closingToken`
    // moving is what tells any in-flight close to stand down.
    closingToken++;
    if (ref?.open) close(ref);
  });

  return (
    // `<dialog>` is an interactive element and a click-the-backdrop-to-dismiss
    // handler is the standard way to build one; the rule reads the tag as
    // non-interactive and cannot see that. Nothing here is keyboard-only
    // functionality hidden behind a mouse event — Escape closes it, from the
    // platform, and the effect above reports that close like any other.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      aria-label={own.labelledBy ? undefined : own.label}
      aria-labelledby={own.labelledBy}
      onClick={(event) => {
        if (own.dismissable === false) return;
        // A click on the backdrop targets the dialog ITSELF — the backdrop is a
        // pseudo-element and cannot be an event target. Comparing against
        // `currentTarget` alone would therefore also close on any click that
        // reached the dialog's own padding, so the hit-test is against the
        // element's box: outside it means the backdrop.
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        const inside =
          event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom;
        if (!inside) own.onClose();
      }}
      class={clsx(
        "ui-modal",
        // No `z-index` and no `position`: a `showModal()` dialog is in the top
        // layer, above every stacking context in the document by definition.
        // `m-auto` is what centres it there — the UA default is `margin: auto`
        // on a modal dialog, and a utility that overrode it would drop the
        // dialog to the top-left corner.
        "base:m-auto base:max-h-[85vh] base:w-full base:max-w-ui-sm",
        "base:rounded-ui-lg base:border base:border-ui-hairline base:bg-ui-surface-raised",
        "base:text-ui-ink base:shadow-[var(--ui-elev-2)]",
        // Two shapes, never both: see {@link ModalProps.frame}.
        // `base:p-0` rather than simply omitting the padding: the user-agent
        // stylesheet gives every `<dialog>` `padding: 1em`, and an author rule
        // is what removes it. Left out, the frame keeps a 16px band the caller
        // cannot see in its own markup — which is what put cire's sticky action
        // bar 16px above the bottom edge it is supposed to sit on.
        own.frame
          ? "base:flex base:flex-col base:overflow-hidden base:p-0"
          : "base:overflow-y-auto base:p-6",
        own.class,
      )}
      {...rest}
    >
      <Show when={rendered()}>{own.children}</Show>
    </dialog>
  );
}
