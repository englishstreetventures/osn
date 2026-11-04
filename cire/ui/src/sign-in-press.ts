import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";

/**
 * How long a press waits for the browser to leave before the button answers
 * again. Longer than cire/api's start leg and musubi's first byte take on a
 * slow phone network; short enough that someone who pressed Stop is not left
 * looking at a button that does nothing.
 */
export const SIGN_IN_PENDING_RESET_MS = 10_000;

const IDLE_LABEL = "Continue with musubi";
const PENDING_LABEL = "Connecting to musubi…";
const STILL_PENDING = "Still connecting to musubi…";

/** How long the status line stays empty before it is refilled, so it is spoken again. */
const REANNOUNCE_MS = 100;

export interface SignInPress {
  /** The button's words: "Continue with musubi", or "Connecting to musubi…" once pressed. */
  label: Accessor<string>;
  /** What the hidden status line says: empty until a press. */
  status: Accessor<string>;
  /** The button's handler: runs `start` once, and only announces a press while connecting. */
  press: () => void;
}

/**
 * What a "Continue with musubi" button does once pressed, on every page that
 * draws one: the portals' sign-in panel and the vendor's claim page.
 *
 * Only the label changes, to "Connecting to musubi…", at full strength, with
 * no dimmed look. A second press does nothing, since it would only cancel the
 * first navigation and spend another of the start leg's per-address requests.
 * A status line, which the caller renders hidden but present from the first
 * paint, says "Connecting to musubi…" on the press and "Still connecting to
 * musubi…" on each press it ignores — emptied and refilled, so a screen reader
 * speaks it again rather than staying silent.
 *
 * The button never stays that way: a page restored from the back-forward
 * cache (Back from musubi) puts it back at once, and a navigation that never
 * completes (Stop, Esc, a network that never answers) puts it back after
 * `SIGN_IN_PENDING_RESET_MS`.
 *
 * It holds no markup and no classes, so each page keeps its own button and
 * places the status line itself. Call it inside a component: it listens for
 * `pageshow` while that component is mounted.
 */
export function createSignInPress(start: () => void): SignInPress {
  const [pending, setPending] = createSignal(false);
  const [status, setStatus] = createSignal("");

  let reset: ReturnType<typeof setTimeout> | undefined;
  let reannounce: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    clearTimeout(reset);
    clearTimeout(reannounce);
    setPending(false);
    setStatus("");
  };

  const press = () => {
    if (pending()) {
      setStatus("");
      clearTimeout(reannounce);
      reannounce = setTimeout(() => setStatus(STILL_PENDING), REANNOUNCE_MS);
      return;
    }
    setPending(true);
    setStatus(PENDING_LABEL);
    reset = setTimeout(settle, SIGN_IN_PENDING_RESET_MS);
    start();
  };

  // Back from musubi restores the page from the back-forward cache exactly as
  // it was left, still connecting; a restore is the browser saying it did not.
  const restored = (event: PageTransitionEvent) => {
    if (event.persisted) settle();
  };

  onMount(() => window.addEventListener("pageshow", restored));
  onCleanup(() => {
    window.removeEventListener("pageshow", restored);
    clearTimeout(reset);
    clearTimeout(reannounce);
  });

  return {
    label: () => (pending() ? PENDING_LABEL : IDLE_LABEL),
    status,
    press,
  };
}
