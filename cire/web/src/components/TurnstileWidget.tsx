import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";

/**
 * Cloudflare Turnstile widget — KEY-OPTIONAL Solid island for the guest site.
 *
 * Mirrors the maps-embed key-optional pattern (`MapPreview`): the sitekey is
 * read from `import.meta.env.PUBLIC_TURNSTILE_SITEKEY`, statically inlined by
 * Vite at build time. When it is absent (no key configured yet), the component
 * renders NOTHING and the form behaves exactly as before — so this ships safely
 * before the widget exists. When present, it lazily injects Cloudflare's small
 * `api.js` script (only on first use, never unconditionally), renders the
 * widget explicitly, and reports the token via `onToken`.
 *
 * The sitekey is public by design (it is embedded in client HTML); the secret
 * lives only on the Worker. The `data-action` carries the Spin telemetry marker.
 *
 * Contract for the parent form:
 *  - Read `PUBLIC_TURNSTILE_SITEKEY` (via {@link turnstileEnabled}) to decide
 *    whether a token is REQUIRED before submit. When the key is unset, submit
 *    proceeds with no token (server skips siteverify too).
 *  - When the key is set, gate submit on a non-null token from `onToken`.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const SCRIPT_ID = "cf-turnstile-script";

/** The build-time sitekey, or undefined when Turnstile is not configured. */
export function turnstileSiteKey(): string | undefined {
  const key = import.meta.env.PUBLIC_TURNSTILE_SITEKEY;
  return key && key.trim() !== "" ? key : undefined;
}

/** True when a sitekey is configured (the widget will render + gate submit). */
export function turnstileEnabled(): boolean {
  return turnstileSiteKey() !== undefined;
}

/** Minimal shape of the global `turnstile` object we call. */
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

/** Inject Cloudflare's api.js once; resolve when `window.turnstile` is ready. */
let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (getTurnstile()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const onReady = () => {
      // api.js may set `window.turnstile` slightly after `load`; poll briefly.
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

interface TurnstileWidgetProps {
  /**
   * Fires with a fresh token on success, and with `null` when the token expires
   * / errors so the parent can re-disable submit. No-op when Turnstile is off.
   */
  onToken: (token: string | null) => void;
  /** Widget theme. Defaults to "auto". */
  theme?: "light" | "dark" | "auto";
  /** Optional extra classes on the wrapper. */
  class?: string;
}

/**
 * Renders the Turnstile challenge when a sitekey is configured; renders nothing
 * otherwise. Cleans up the widget instance on unmount.
 */
export function TurnstileWidget(props: TurnstileWidgetProps) {
  const siteKey = turnstileSiteKey();
  const [failed, setFailed] = createSignal(false);
  const labelId = createUniqueId();
  let container: HTMLDivElement | undefined;
  let widgetId: string | undefined;

  onMount(async () => {
    if (!siteKey || !container) return;
    try {
      await loadTurnstileScript();
      const ts = getTurnstile();
      if (!ts || !container) {
        setFailed(true);
        return;
      }
      widgetId = ts.render(container, {
        sitekey: siteKey,
        // Spin telemetry marker (account-level aggregate; carries no PII).
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
    } catch {
      // Network failure loading api.js — or a synchronous render() throw.
      // Surface a hint; the parent keeps submit disabled because no token
      // ever arrives (fail-closed on the UX side too — the server enforces
      // the real gate).
      setFailed(true);
      props.onToken(null);
    }
  });

  onCleanup(() => {
    const ts = getTurnstile();
    if (ts && widgetId) {
      try {
        ts.remove(widgetId);
      } catch {
        // Widget already torn down — ignore.
      }
    }
  });

  return (
    <Show when={siteKey}>
      <div class={props.class}>
        <div ref={container} aria-labelledby={labelId} />
        <span id={labelId} class="sr-only">
          Human verification challenge
        </span>
        <Show when={failed()}>
          <p class="font-body text-error mt-2 text-[0.78rem]" role="alert">
            Couldn&apos;t load the verification challenge. Refresh and try again.
          </p>
        </Show>
      </div>
    </Show>
  );
}
