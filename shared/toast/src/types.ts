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
}
