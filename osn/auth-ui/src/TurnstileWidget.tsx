import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";

import { LoadFailed } from "./LoadFailed";

/**
 * Cloudflare Turnstile widget — KEY-OPTIONAL Solid island for the OSN auth
 * surface (`Register`, `SignIn` and `RecoveryLoginForm`'s emailed-link step).
 *
 * `@osn/auth-ui` belongs to OSN, not to one app, so — unlike the guest-site
 * widget — the sitekey is passed in as a PROP rather than read from
 * `import.meta.env`. The host, today Musubi alone, reads its own build-time
 * site key and threads it down.
 *
 * Contract: when `siteKey` is undefined/blank, this renders NOTHING and the
 * parent form behaves exactly as before (Turnstile not configured). When set, it
 * lazily injects Cloudflare's `api.js`, renders the widget, and reports the
 * token via `onToken`. The sitekey is public; the secret lives only on osn-api.
 *
 * A challenge that cannot load — the script refused by a content blocker, an
 * extension or a network filter, a load that never finishes, or the widget's
 * own error — shows `LoadFailed`'s line: the causes a person can act on, the
 * host's `alternative` if it gives one, and Try again, which loads the script
 * afresh where it failed and renders the challenge again. Focus moves to the
 * challenge as the line goes, so it never falls to the page. The form's submit
 * stays the host's: with no token, it stays disabled.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const SCRIPT_ID = "cf-turnstile-script";

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      "timeout-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
    },
  ): string;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
}

function getTurnstile(): TurnstileApi | undefined {
  return (globalThis as { turnstile?: TurnstileApi }).turnstile;
}

/** The host the script loads from, named in the failed-load line. */
const SCRIPT_HOST = new URL(SCRIPT_SRC).host;

/**
 * How long a load may take, from the moment it starts, before it counts as
 * failed. A network that drops the request rather than refusing it would
 * otherwise leave the form waiting with no word.
 */
const LOAD_DEADLINE_MS = 15_000;

/** How often a loaded script is looked at for `window.turnstile`. */
const LOAD_POLL_MS = 50;

let scriptPromise: Promise<void> | null = null;

/**
 * Loads `api.js` and resolves when `window.turnstile` exists; calls while a
 * load is in flight share it. Rejects when the script errors or the deadline
 * passes. A failed load's element is removed, so the next call — Try again —
 * appends a new script rather than waiting on one that will never run.
 */
function loadTurnstileScript(): Promise<void> {
  if (getTurnstile()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
  const attempt = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const onError = () => finish(new Error("turnstile script error"));
    const deadline = setTimeout(
      () => finish(new Error("turnstile load timeout")),
      LOAD_DEADLINE_MS,
    );
    function finish(error?: Error) {
      done = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      script?.removeEventListener("error", onError);
      script?.removeEventListener("load", look);
      if (error) reject(error);
      else resolve();
    }
    // Looks for `window.turnstile` once the script has run, and again every
    // 50 ms until it appears or the deadline passes. One loop at a time: an
    // element already in the page starts it at once, and its `load` event, if
    // it comes, restarts it rather than starting a second.
    function look() {
      if (done) return;
      clearTimeout(timer);
      if (getTurnstile()) return finish();
      timer = setTimeout(look, LOAD_POLL_MS);
    }
    const loading = !script;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("error", onError, { once: true });
    script.addEventListener("load", look, { once: true });
    // An element already in the page may have run before this call.
    if (!loading) look();
  });
  scriptPromise = attempt;
  // Only a load in flight is shared: once it settles, `window.turnstile`
  // answers the next call, or a new script is loaded.
  const settled = () => {
    if (scriptPromise === attempt) scriptPromise = null;
  };
  attempt.then(settled, () => {
    settled();
    script?.remove();
  });
  return attempt;
}

export interface TurnstileWidgetProps {
  /**
   * The build-time `PUBLIC_TURNSTILE_SITEKEY` from the consuming app. Undefined
   * / blank ⇒ Turnstile not configured ⇒ renders nothing.
   */
  siteKey?: string;
  /** Fires with a fresh token on success, `null` on expiry/error. */
  onToken: (token: string | null) => void;
  /**
   * Handed a `reset()` once the widget has rendered. Turnstile tokens are
   * SINGLE-USE: once a token has been submitted to (and redeemed by) a backend,
   * calling `reset()` discards it and asks Cloudflare for a fresh challenge —
   * the new token arrives via `onToken`. Without this, a form that re-submits
   * (e.g. a failed/retried sign-in) replays the already-redeemed token and the
   * server fails it closed (`timeout-or-duplicate`), trapping the user in a
   * login loop. The callback is a no-op until the widget exists, so callers can
   * invoke it unconditionally.
   */
  onReady?: (controls: { reset: () => void }) => void;
  /**
   * One sentence naming a way on that needs no challenge, added to the line a
   * failed load shows: `SignIn`'s recovery code. Absent where there is none,
   * as on `Register`.
   */
  alternative?: string;
  theme?: "light" | "dark" | "auto";
  class?: string;
}

/** True when a usable sitekey is provided. */
export function turnstileEnabled(siteKey: string | undefined): boolean {
  return !!siteKey && siteKey.trim() !== "";
}

export function TurnstileWidget(props: TurnstileWidgetProps) {
  const siteKey = () => (props.siteKey && props.siteKey.trim() !== "" ? props.siteKey : undefined);
  const [failed, setFailed] = createSignal(false);
  const labelId = createUniqueId();
  let container: HTMLDivElement | undefined;
  let widgetId: string | undefined;
  let disposed = false;
  // Each load is numbered, so the answer to one that Try again replaced is
  // dropped.
  let attempts = 0;

  function removeWidget() {
    const ts = getTurnstile();
    if (ts && widgetId !== undefined) {
      try {
        ts.remove(widgetId);
      } catch {
        // Already torn down.
      }
    }
    widgetId = undefined;
  }

  function fail() {
    setFailed(true);
    props.onToken(null);
  }

  function show() {
    const key = siteKey();
    if (!key || !container) return;
    const attempt = ++attempts;
    const current = () => !disposed && attempt === attempts;
    loadTurnstileScript()
      .then(() => {
        if (!current()) return;
        const ts = getTurnstile();
        if (!ts || !container) {
          fail();
          return;
        }
        widgetId = ts.render(container, {
          sitekey: key,
          action: "turnstile-spin-v1",
          theme: props.theme ?? "auto",
          callback: (token) => {
            setFailed(false);
            props.onToken(token);
          },
          "expired-callback": () => props.onToken(null),
          "timeout-callback": () => props.onToken(null),
          "error-callback": fail,
        });
        // Hand the parent a reset() bound to THIS widget instance so it can
        // force a fresh token after the current one is redeemed (single-use).
        props.onReady?.({
          reset: () => {
            const api = getTurnstile();
            if (!api || widgetId === undefined) return;
            // Drop the stale token immediately so the form can't replay it in
            // the gap before Cloudflare delivers a new one via `callback`.
            props.onToken(null);
            try {
              api.reset(widgetId);
            } catch {
              // Widget already torn down — nothing to reset.
            }
          },
        });
        return;
      })
      .catch(() => {
        if (current()) fail();
      });
  }

  /** Try again: drops the line, puts focus on the challenge, and loads and renders it afresh. */
  function retry() {
    setFailed(false);
    removeWidget();
    container?.focus();
    show();
  }

  onMount(show);

  onCleanup(() => {
    disposed = true;
    removeWidget();
  });

  const failureLine = () =>
    [
      `Couldn't load the verification challenge. A content blocker, a browser extension or a network that blocks ${SCRIPT_HOST} can stop it. Turn the blocker off for this site, or use another network.`,
      props.alternative,
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <Show when={siteKey()}>
      <div class={props.class}>
        {/* A group named by the label below, and where Try again puts focus:
            `tabindex="-1"` takes it from code, never from Tab, and it draws no
            mark, since it is where focus is put, not a control. */}
        <div
          ref={container}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not `<fieldset>`: Cloudflare renders its widget into this element, and a fieldset brings its own border, padding and minimum width.
          role="group"
          aria-labelledby={labelId}
          tabindex="-1"
          class="focus:outline-none"
        />
        <span id={labelId} class="sr-only">
          Human verification challenge
        </span>
        <Show when={failed()}>
          <div class="mt-2">
            <LoadFailed lead={failureLine()} error={undefined} onRetry={retry} />
          </div>
        </Show>
      </div>
    </Show>
  );
}
