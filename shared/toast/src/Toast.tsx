import { Show } from "solid-js";

import { DEFAULT_DURATION, dismiss, pause, scheduleDismiss } from "./store";
import type { Toast as ToastModel } from "./types";

interface Mark {
  /** Seen, never read. */
  glyph: string;
  /** Read, never seen. */
  word: string;
}

/**
 * Tone marks, following `Notice.tsx` in the host portal: a differently-SHAPED
 * glyph per tone rather than three colours of one shape. Tone carried by hue
 * alone puts "saved" and "failed to save" in the same rectangle, and
 * error/warning is exactly the pair red-green colour blindness collapses.
 *
 * The glyph is `aria-hidden` and a word is read in its place — "✕" is not a
 * thing to hear.
 */
const MARK = {
  success: { glyph: "✓", word: "Success" },
  error: { glyph: "✕", word: "Error" },
  warning: { glyph: "!", word: "Warning" },
  info: { glyph: "i", word: "Note" },
  loading: { glyph: "◠", word: "Working" },
} satisfies Readonly<Record<ToastModel["tone"], Mark>>;

export function ToastItem(props: { toast: ToastModel; class?: string }) {
  /**
   * Resume the dwell after a pause. NOT the clock's owner — `upsert` starts it,
   * and this only ever restarts one it stopped.
   *
   * That split is deliberate. The first cut had the item own the clock via a
   * `createEffect`, which looked like it restarted on a tone change but did
   * not: `props.toast` is a plain object, so those reads track nothing. It
   * worked only because an update replaces the toast object and `<For>`
   * remounts the row — a mechanism nobody would know not to optimise away.
   */
  const resumeClock = () =>
    scheduleDismiss(props.toast.id, props.toast.duration ?? DEFAULT_DURATION);

  return (
    <div
      class={`osn-toast osn-toast--${props.toast.tone}${props.class ? ` ${props.class}` : ""}${
        props.toast.class ? ` ${props.toast.class}` : ""
      }${props.toast.dismissing ? " osn-toast--leaving" : ""}`}
      // An error interrupts (`assertive`): the thing the user just did did not
      // happen. Everything else waits its turn.
      role={props.toast.tone === "error" ? "alert" : "status"}
      aria-live={props.toast.politeness ?? (props.toast.tone === "error" ? "assertive" : "polite")}
      data-tone={props.toast.tone}
      // Pause while the pointer is on it or focus is inside — a toast that
      // expires mid-sentence is a toast nobody finished reading.
      onMouseEnter={() => pause(props.toast.id)}
      onMouseLeave={resumeClock}
      onFocusIn={() => pause(props.toast.id)}
      onFocusOut={resumeClock}
    >
      <span aria-hidden="true" class="osn-toast__glyph">
        {MARK[props.toast.tone].glyph}
      </span>
      <span class="osn-toast__sr">{MARK[props.toast.tone].word}: </span>
      {/*
        The message lives in its OWN element whose `textContent` is EXACTLY the
        message, with the glyph and the screen-reader word as SIBLINGS outside
        it. `cire/invites`'s browser test finds a toast with
        `[...querySelectorAll("div")].find(d => d.textContent === message)` —
        folding the tone word in here would break that lookup, and with it the
        z-index regression guard that assertion protects.
      */}
      <div class="osn-toast__message">{props.toast.message}</div>
      <Show when={props.toast.action}>
        {(action) => (
          <button
            type="button"
            class="osn-toast__action"
            onClick={() => {
              action().onClick();
              dismiss(props.toast.id);
            }}
          >
            {action().label}
          </button>
        )}
      </Show>
      <Show when={props.toast.dismissible}>
        <button
          type="button"
          class="osn-toast__close"
          aria-label="Dismiss notification"
          onClick={() => dismiss(props.toast.id)}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </Show>
    </div>
  );
}
