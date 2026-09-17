import type { JSX } from "solid-js";

/**
 * The four tones a toast can carry.
 *
 * `success` and `error` are the only two the apps use today; `info` and
 * `warning` exist because a tone set that can't say "heads up" pushes callers
 * back onto `error`, and an error that isn't one trains people to ignore the
 * real ones.
 *
 * Tone is never carried by hue alone — see `MARK` in `Toast.tsx`. `error` and
 * `warning` are exactly the pair red-green colour blindness collapses, so each
 * tone leads with a differently-SHAPED glyph and an `sr-only` word.
 */
export type ToastTone = "success" | "error" | "info" | "warning" | "loading";

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface ToastOptions {
  /**
   * Milliseconds on screen. `Infinity` pins the toast until it is dismissed —
   * which is what `loading` uses, and the only sane default for one.
   */
  duration?: number;
  /**
   * Stable identity. Raising a toast with an id that is already on screen
   * UPDATES it rather than stacking a second copy, which is what makes
   * `toast.promise` able to turn one spinner into one result.
   */
  id?: string;
  /** Show a close button. Off by default — a toast that auto-dismisses doesn't need one. */
  dismissible?: boolean;
  /** One optional action. `onClick` runs, then the toast dismisses itself. */
  action?: { label: string; onClick: () => void };
  /** Extra classes on the toast element. Appended, so they win on ties. */
  class?: string;
  /**
   * Override the live-region politeness. Defaults to `assertive` for `error`
   * and `polite` for everything else: an error interrupts because the thing
   * the user just did did not happen, a confirmation does not.
   */
  politeness?: "polite" | "assertive";
}

export interface Toast extends ToastOptions {
  id: string;
  tone: ToastTone;
  message: JSX.Element;
  /** Monotonic, so the render order is raise order regardless of Map iteration. */
  seq: number;
  /** Set when the toast is leaving, so the exit animation can run before removal. */
  dismissing?: boolean;
}

export interface ToasterProps {
  position?: ToastPosition;
  /** Classes on the fixed container — this is where a consumer's z-index layer goes. */
  class?: string;
  /** Inline styles on the fixed container, for offsets a class can't express. */
  style?: JSX.CSSProperties;
  /** Classes applied to every toast this Toaster renders. */
  toastClass?: string;
  /** Max toasts on screen at once. Older ones are dropped from the far end. */
  limit?: number;
  /**
   * Raise the container into the **top layer** while it has something to show.
   *
   * Turn this on in any app that opens a `<dialog>` with `showModal()` — which
   * is every app using `@shared/ui`'s `Modal`. A modal dialog renders in the top
   * layer, which paints above every stacking context in the document *by
   * definition*, so no `z-index` on this container can put a toast over it. The
   * RSVP save toast fires while the sheet is still open, which is precisely the
   * case: without this it is raised behind the sheet it confirms, and the one
   * confirmation a partial save gets is never seen.
   *
   * It works by making the container a `popover` and showing it whenever there
   * is a toast to show — so it enters the top layer AFTER any dialog that was
   * already open, and top-layer order is entry order. Off by default because it
   * changes how the container is painted, and an app with no top-layer dialogs
   * gains nothing from it.
   *
   * **It buys paint, not reach.** A modal dialog makes every node outside it
   * INERT, and the top layer is no exemption — so while such a dialog is open
   * the toast is seen and nothing more: its close button does not respond and
   * assistive technology does not announce it. Only a descendant of the dialog
   * escapes that, and a container mounted once at the page root cannot be one.
   * A toast raised over a modal therefore has to be a confirmation the dialog
   * itself also states, never the only place something is said.
   */
  topLayer?: boolean;
}
