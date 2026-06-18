import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";

/**
 * Cloudflare Turnstile widget — KEY-OPTIONAL Solid island for the OSN auth
 * surface (Register + SignIn).
 *
 * `@osn/ui` is a shared library consumed by multiple apps (the organiser portal,
 * osn-social), so — unlike the guest-site widget — the sitekey is passed in as a
 * PROP rather than read from `import.meta.env`. The consuming app reads its own
 * build-time `PUBLIC_TURNSTILE_SITEKEY` and threads it down.
 *
 * Contract: when `siteKey` is undefined/blank, this renders NOTHING and the
 * parent form behaves exactly as before (Turnstile not configured). When set, it
 * lazily injects Cloudflare's `api.js`, renders the widget, and reports the
 * token via `onToken`. The sitekey is public; the secret lives only on osn-api.
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

let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (getTurnstile()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const onReady = () => {
      const start = Date.now();
      const tick = () => {
        if (getTurnstile()) return resolve();
        if (Date.now() - start > 10_000) return reject(new Error("turnstile load timeout"));
        setTimeout(tick, 50);
      };
      tick();
    };
    if (existing) {
      if (getTurnstile()) resolve();
      else existing.addEventListener("load", onReady, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener("error", () => reject(new Error("turnstile script error")), {
      once: true,
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
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

  onMount(() => {
    const key = siteKey();
    if (!key || !container) return;
    loadTurnstileScript()
      .then(() => {
        const ts = getTurnstile();
        if (!ts || !container) {
          setFailed(true);
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
          "error-callback": () => {
            setFailed(true);
            props.onToken(null);
          },
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
        setFailed(true);
        props.onToken(null);
      });
  });

  onCleanup(() => {
    const ts = getTurnstile();
    if (ts && widgetId) {
      try {
        ts.remove(widgetId);
      } catch {
        // Already torn down.
      }
    }
  });

  return (
    <Show when={siteKey()}>
      <div class={props.class}>
        <div ref={container} aria-labelledby={labelId} />
        <span id={labelId} class="sr-only">
          Human verification challenge
        </span>
        <Show when={failed()}>
          <p class="text-destructive mt-2 text-xs" role="alert">
            Couldn&apos;t load the verification challenge. Refresh and try again.
          </p>
        </Show>
      </div>
    </Show>
  );
}
