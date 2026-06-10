import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { isValidPinterestUrl } from "./pinterest";

interface PinterestBoardProps {
  url: string;
  eventName: string;
}

// Stable per-instance id so the anchor and the cache-busted script tag line up.
let nextId = 0;
const nextAnchorId = () => `pin-board-${++nextId}`;

// Session-scoped consent key. Opt-IN only: the absence of this key (the
// default for every fresh visit) means "no consent", so the Pinterest tracker
// script never loads until the guest explicitly clicks "Load Pinterest board".
// We persist within the session so the choice isn't re-asked on every mount
// (boards remount when the details modal reopens), but it never survives the
// visit — a returning guest starts un-consented again.
const CONSENT_KEY = "cire:pinterest-consent";

function readConsent(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    // Private-mode / storage-disabled: treat as un-consented (safe default).
    return false;
  }
}

function persistConsent(): void {
  try {
    sessionStorage.setItem(CONSENT_KEY, "granted");
  } catch {
    // Storage unavailable — consent still applies for this mount via the
    // in-memory signal; we just can't remember it across remounts.
  }
}

// Grace period for Pinterest's script to load, run, and transform our `<a>`
// placeholder. Tracker-blocker extensions (uBlock, Brave Shields, Privacy
// Badger) put `assets.pinterest.com/js/pinit_main.js` on EasyPrivacy and fire
// a `blocked:other` net::ERR. We catch that two ways: (1) `script.onerror`,
// (2) a timeout that checks whether pinit_main actually transformed our
// anchor — covers the case where the script loaded but a later request
// (widgets.pinterest.com / i.pinimg.com) was blocked.
//
// 2.5s catches p95 script-eval + first widget render on the happy path
// (~1–2s on mid-tier mobile) without making blocked users stare at dead air
// for the full 4s a more conservative window would impose. PR #28 perf review.
const EMBED_TIMEOUT_MS = 2500;

/**
 * Renders a Pinterest board using Pinterest's documented embed widget pattern
 * (https://developers.pinterest.com/docs/web-features/widgets/#board-widget),
 * behind a session-scoped opt-in consent gate, with a graceful fallback to a
 * plain outbound link whenever the embed isn't shown (no consent, invalid
 * URL, or a tracker blocker stopping the embed from rendering).
 *
 * Consent gate (S-H3 / C-H3): `assets.pinterest.com/js/pinit_main.js` is a
 * third-party tracker that ships guest IP / UA / behaviour to Pinterest (an
 * undeclared subprocessor) with no SRI hash available. Loading it on mount
 * would be a non-consensual transfer under ePrivacy. So we do NOT inject it on
 * mount: the default render is the fallback link plus a small "Load Pinterest
 * board?" affordance, and the script only injects after the guest clicks it.
 * The fallback link stays visible regardless so non-consenting guests still
 * reach the board.
 *
 * SRI: Pinterest publishes no stable Subresource-Integrity hash for
 * pinit_main.js (the IIFE is rolled frequently and the URL is cache-busted),
 * so we can't pin it. `referrerpolicy="no-referrer"` trims the data we leak in
 * the request, and the opt-in consent gate above is the compensating control
 * for the missing integrity guarantee.
 *
 * Why we load `pinit_main.js` directly instead of `pinit.js`: pinit.js gates
 * pinit_main behind a daily `window.PIN_<timestamp>` key — once loaded, it
 * won't re-load or re-scan. Boards mount after claim (the details modal opens
 * later), so we need a fresh scan on every mount. Loading pinit_main.js with
 * a cache-busted query re-runs its IIFE which re-scans the DOM and picks up
 * the new `<a data-pin-do>` we just rendered.
 *
 * URL safety: `isValidPinterestUrl` (strict host + path-segment allowlist)
 * gates the URL before it ever lands in a Pinterest script's hands or in our
 * fallback anchor's href.
 */
export function PinterestBoard(props: PinterestBoardProps) {
  const id = nextAnchorId();
  const [consented, setConsented] = createSignal(false);
  const [embedFailed, setEmbedFailed] = createSignal(false);
  let anchorRef: HTMLAnchorElement | undefined;

  // Injected script + fallback timer, tracked at component scope so the single
  // top-level onCleanup below can tear them down. `injectEmbedScript` runs from
  // a click handler (outside the reactive owner), so it can't register its own
  // onCleanup — we centralise teardown here instead.
  let injectedScript: HTMLScriptElement | undefined;
  let timeoutId: number | undefined;

  onMount(() => {
    // Restore a consent granted earlier in this session so we don't re-prompt
    // on remount. Still opt-in: a fresh visit has no stored consent.
    if (readConsent()) {
      setConsented(true);
      injectEmbedScript();
    }
  });

  onCleanup(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    injectedScript?.remove();
  });

  // Injects the tracker script. Only ever called after consent (restored from
  // session storage on mount, or via an explicit user click) — never on a
  // fresh, un-consented mount.
  function injectEmbedScript() {
    if (!isValidPinterestUrl(props.url)) return;

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    // No SRI is available for this third-party script (see component doc); the
    // consent gate is the compensating control. `no-referrer` trims what the
    // request leaks to Pinterest.
    script.referrerPolicy = "no-referrer";
    script.src = `https://assets.pinterest.com/js/pinit_main.js?_=${id}`;
    script.onerror = () => setEmbedFailed(true);
    document.body.appendChild(script);
    injectedScript = script;

    // Even if the script loads, a downstream block (pidgets API, image CDN) can
    // leave the anchor untransformed. Pinit_main marks processed anchors with
    // `data-pin-internal`; if our anchor still carries the original `data-pin-do`
    // after the grace period, the embed failed.
    timeoutId = window.setTimeout(() => {
      if (anchorRef?.isConnected && anchorRef.hasAttribute("data-pin-do")) {
        setEmbedFailed(true);
      }
    }, EMBED_TIMEOUT_MS);
  }

  function grantConsent() {
    persistConsent();
    setConsented(true);
    setEmbedFailed(false);
    injectEmbedScript();
  }

  return (
    <Show when={isValidPinterestUrl(props.url)}>
      {/* The outbound fallback link is always present so every guest — */}
      {/* consenting or not — can reach the board. */}
      <div class="mt-2 flex justify-center">
        <a
          href={props.url}
          target="_blank"
          rel="noopener noreferrer"
          class="border-gold font-body text-gold hover:bg-gold hover:text-bg inline-block rounded-sm border px-5 py-2.5 text-[0.78rem] tracking-[0.12em] uppercase transition-colors duration-200"
        >
          View moodboard on Pinterest ↗
        </a>
      </div>

      <Show
        when={consented() && !embedFailed()}
        fallback={
          // Default state: opt-in consent affordance. No script has loaded.
          <div class="font-body text-fg/70 mt-2 flex flex-col items-center gap-2 text-center text-[0.72rem]">
            <p>
              Load Pinterest board? This loads content from Pinterest, which may set cookies or
              collect usage data.
            </p>
            <button
              type="button"
              onClick={grantConsent}
              class="border-gold text-gold hover:bg-gold hover:text-bg rounded-sm border px-4 py-1.5 text-[0.7rem] tracking-[0.12em] uppercase transition-colors duration-200"
            >
              Load Pinterest board
            </button>
          </div>
        }
      >
        <div class="mt-2 flex justify-center">
          <a
            ref={anchorRef}
            id={id}
            data-pin-do="embedBoard"
            data-pin-board-width="400"
            data-pin-scale-height="240"
            data-pin-scale-width="80"
            href={props.url}
            aria-label={`Pinterest board for ${props.eventName}`}
          />
        </div>
      </Show>
    </Show>
  );
}
