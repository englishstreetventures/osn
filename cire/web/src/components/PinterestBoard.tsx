import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { isEmbeddablePinterestBoardUrl, isSafePinterestLinkUrl } from "./pinterest";

interface PinterestBoardProps {
  url: string;
  eventName: string;
}

// Stable per-instance id so the anchor and the cache-busted script tag line up.
let nextId = 0;
const nextAnchorId = () => `pin-board-${++nextId}`;

// Persisted consent key. Opt-IN only: the absence of this key (the default for
// every first visit) means "no consent", so the Pinterest tracker script never
// loads until the guest explicitly clicks "Load Pinterest board". We persist in
// localStorage so the choice survives the visit — a returning guest who already
// accepted is never re-prompted, and every board after the first loads straight
// away.
const CONSENT_KEY = "cire:pinterest-consent";

// Shared, module-level reactive consent state. A SINGLE signal backs every
// PinterestBoard on the page, so accepting on one board immediately flips all
// the others (the details modal can render several boards at once, and the page
// may show more than one). Seeded lazily from localStorage on first read so the
// persisted choice is picked up without re-prompting.
const [consentGranted, setConsentGranted] = createSignal(readPersistedConsent());

function readPersistedConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    // Private-mode / storage-disabled: treat as un-consented (safe default).
    return false;
  }
}

function grantConsentGlobally(): void {
  try {
    localStorage.setItem(CONSENT_KEY, "granted");
  } catch {
    // Storage unavailable — consent still applies for this page via the shared
    // in-memory signal below; we just can't remember it across visits.
  }
  setConsentGranted(true);
}

/**
 * Test-only: reset the shared in-memory consent signal to whatever localStorage
 * currently says. Lets a test simulate a fresh page load (new module evaluation)
 * after seeding or clearing localStorage, without a real reload.
 */
export function resetPinterestConsentForTest(): void {
  setConsentGranted(readPersistedConsent());
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
 * behind a persisted, page-wide opt-in consent gate, with a graceful fallback
 * to a plain outbound link whenever the embed isn't shown (no consent, invalid
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
 * One-time, page-wide consent: the choice is backed by a single shared signal
 * (see `consentGranted` above) and persisted to localStorage. Accepting on one
 * board flips every other board on the page in the same tick, and the next
 * visit reads the persisted consent so the guest is never re-prompted.
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
 * URL safety + graceful degradation: two separate gates (see `pinterest.ts`).
 * `isSafePinterestLinkUrl` (https + Pinterest-host allowlist, loose on path)
 * gates the always-visible outbound fallback link, so the moodboard stays
 * reachable even when the URL is a `pin.it` short link or some other shape the
 * board widget can't embed. `isEmbeddablePinterestBoardUrl` (the strict
 * `/user/board` shape) is the stricter gate before the URL ever lands in the
 * embed script or the `<a data-pin-do>` anchor. The fallback link therefore
 * shows whenever the URL is a safe Pinterest link — even if the embed script is
 * blocked/slow (timeout/onerror) OR the URL isn't an embeddable board.
 */
export function PinterestBoard(props: PinterestBoardProps) {
  const id = nextAnchorId();
  const [embedFailed, setEmbedFailed] = createSignal(false);
  let anchorRef: HTMLAnchorElement | undefined;

  // Injected script + fallback timer, tracked at component scope so the single
  // top-level onCleanup below can tear them down.
  let injectedScript: HTMLScriptElement | undefined;
  let timeoutId: number | undefined;

  // React to the shared, page-wide consent signal. This fires for all three
  // paths uniformly: (1) consent already persisted at mount, (2) this board's
  // own "Load Pinterest board" click, (3) another board on the page granting
  // consent (the shared signal flips, this effect re-runs and reveals us too).
  // Guarded so the tracker injects exactly once per mount.
  createEffect(() => {
    if (consentGranted() && !injectedScript) {
      setEmbedFailed(false);
      injectEmbedScript();
    }
  });

  onCleanup(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    injectedScript?.remove();
  });

  // Injects the tracker script. Only ever called after consent (persisted on
  // mount, or via an explicit user click on this or another board) — never on a
  // fresh, un-consented mount.
  function injectEmbedScript() {
    if (!isEmbeddablePinterestBoardUrl(props.url)) return;

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    // No SRI is available for this third-party script (see component doc); the
    // consent gate is the compensating control. `no-referrer` trims what the
    // request leaks to Pinterest.
    script.referrerPolicy = "no-referrer";
    script.src = `https://assets.pinterest.com/js/pinit_main.js?_=${id}`;
    script.addEventListener("error", () => setEmbedFailed(true));
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
    // Flip the shared signal + persist. The createEffect above does the actual
    // injection — for this board and every other one mounted on the page.
    grantConsentGlobally();
  }

  // Whether this URL can be rendered as an embedded board widget at all. A safe
  // Pinterest link that isn't an embeddable board shape (a `pin.it` short link,
  // a bare pin/profile) still gets the always-visible fallback link below — it
  // just never shows the consent prompt or the embed anchor.
  const embeddable = () => isEmbeddablePinterestBoardUrl(props.url);

  return (
    <Show when={isSafePinterestLinkUrl(props.url)}>
      {/* The outbound fallback link is ALWAYS present whenever the URL is a safe */}
      {/* Pinterest link — even if the embed is blocked, slow, or the URL isn't an */}
      {/* embeddable board shape — so every guest can always reach the moodboard. */}
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

      {/* The consent prompt + embed anchor only exist when the URL is an */}
      {/* embeddable board shape. A safe-but-not-embeddable link (pin.it short */}
      {/* link, bare pin/profile) shows the fallback link above and nothing else. */}
      <Show when={embeddable()}>
        <Show
          when={consentGranted() && !embedFailed()}
          fallback={
            // Default state: opt-in consent affordance. No script has loaded.
            <div class="font-body text-fg/70 mt-2 flex flex-col items-center gap-2 text-center text-[0.72rem]">
              <p>
                Load Pinterest board? This embeds content from Pinterest, a third party that may set
                cookies and collect usage data. Your choice is remembered for this site. See our{" "}
                <a href="/privacy" class="text-gold underline">
                  privacy notice
                </a>
                .
              </p>
              <button
                type="button"
                onClick={grantConsent}
                class="border-gold text-gold hover:bg-gold hover:text-bg rounded-sm border px-4 py-1.5 text-[0.7rem] tracking-[0.12em] uppercase transition-colors duration-200"
              >
                Load Pinterest content
              </button>
            </div>
          }
        >
          {/* The Pinterest widget renders a fixed-width iframe (data-pin-board-
              width). On narrow viewports that pixel width can exceed the modal's
              content box, so the embed lives in a max-width, horizontally-
              scrollable, centred box: any overflow scrolls *within* this box
              instead of pushing the whole page sideways. */}
          <div class="-mx-6 mt-2 overflow-x-auto px-6">
            <div class="flex min-w-min justify-center">
              <a
                ref={anchorRef}
                id={id}
                data-pin-do="embedBoard"
                data-pin-board-width="320"
                data-pin-scale-height="240"
                data-pin-scale-width="80"
                href={props.url}
                aria-label={`Pinterest board for ${props.eventName}`}
              />
            </div>
          </div>
        </Show>
      </Show>
    </Show>
  );
}
