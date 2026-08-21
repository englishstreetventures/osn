import { createEffect, Show } from "solid-js";

import { dismiss, pause, scheduleDismiss } from "./store";
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

export function ToastItem(props: { toast: ToastModel; defaultDuration: number; class?: string }) {
  const duration = () => props.toast.duration ?? props.defaultDuration;

  const startClock = () => scheduleDismiss(props.toast.id, duration());

  /**
   * Start the clock on mount, and restart it whenever tone or duration change.
   * `toast.promise` swaps tone and message under a STABLE id, so the outcome
   * would otherwise inherit whatever was left of the spinner's dwell — and a
   * spinner's dwell is `Infinity`, which would pin the result on screen for
   * ever. Reading both fields is what subscribes this effect to them.
   */
  createEffect(() => {
    // Read both so the effect subscribes to them; `void` because the read
    // itself is the point and the values are used inside `startClock`.
    void props.toast.tone;
    void duration();
    if (!props.toast.dismissing) startClock();
  });

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
      onMouseLeave={startClock}
      onFocusIn={() => pause(props.toast.id)}
      onFocusOut={startClock}
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
