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

// NOTE (mobile embed re-enabled): the consent-gated rich embed now renders on
// ALL devices, touch included. It was previously desktop-only because the
// Pinterest widget "repeatedly failed on mobile" — but the dominant cause of
// those failures was unembeddable `pin.it` short links being stored verbatim
// (boards are now resolved to canonical `/user/board` URLs at import time, and
// the live data was backfilled), not a touch-specific defect. The success-
// detection MutationObserver + connection-scaled failure cutoff already make
// the embed self-healing on slow mobile networks, and the always-visible
// fallback link below the embed is the safety net if a board still doesn't
// render. So there is no longer a separate touch path: every device gets the
// consent gate → embed → fallback link. (If mobile proves unreliable again,
// reverting this commit restores the desktop-only capability split.)

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

// Hard failure cutoff for Pinterest's script to load, run, and transform our
// `<a>` placeholder into an iframe. Tracker-blocker extensions (uBlock, Brave
// Shields, Privacy Badger) put `assets.pinterest.com/js/pinit_main.js` on
// EasyPrivacy and fire a `blocked:other` net::ERR. We catch failure three ways:
// (1) `script.onerror` (fast, definitive — a blocked/404 script), (2) a
// MutationObserver that watches for the SUCCESSFUL transform and cancels this
// cutoff the moment Pinterest replaces/processes our anchor, (3) this cutoff
// firing with the anchor still untransformed (covers the case where the script
// loaded but a later request — pidgets API / i.pinimg.com — was blocked, with
// no `error` event on our tag).
//
// Why this is generous, not the old fixed 2.5s race: on mobile (slower script
// eval + render + network) Pinterest's transform routinely finishes AFTER 2.5s,
// so a blind 2.5s timeout FALSELY marked a board that *did* render as failed and
// hid it — the guest was left with only the fallback link. Success is now
// detected by observation (path 2), so the cutoff exists only to stop a *real*
// block leaving the embed slot blank forever. We can therefore afford a much
// longer window: it never delays a board that renders (the observer cancels it),
// it only bounds the wait for boards that genuinely never render.
//
// Slow connections get the longer window; fast ones can fall back a touch sooner
// since a working embed cancels the timer regardless. `navigator.connection` is
// best-effort (absent on Safari/iOS) — we fall back to the conservative value.
const EMBED_TIMEOUT_SLOW_MS = 8000;
const EMBED_TIMEOUT_FAST_MS = 6000;

// Pick a failure cutoff. We default to the slow value (so a board that would
// render is never hidden) and only shorten it when the connection API positively
// reports a fast, non-data-saver link. iOS Safari — the primary mobile target —
// exposes no `navigator.connection`, so it always gets the full slow window.
function resolveEmbedTimeoutMs(): number {
  try {
    const connection = (
      navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean };
      }
    ).connection;
    if (!connection) return EMBED_TIMEOUT_SLOW_MS;
    if (connection.saveData) return EMBED_TIMEOUT_SLOW_MS;
    const type = connection.effectiveType;
    if (type === "slow-2g" || type === "2g" || type === "3g") return EMBED_TIMEOUT_SLOW_MS;
    // "4g" (or anything else reported as fast) — embed should arrive quickly; a
    // working embed still cancels the timer, so this only speeds up the *failure*
    // fallback on fast links.
    return EMBED_TIMEOUT_FAST_MS;
  } catch {
    return EMBED_TIMEOUT_SLOW_MS;
  }
}

// Pinterest's `pinit_main.js` signals a successful board render by mutating our
// placeholder anchor: it strips `data-pin-do` and stamps `data-pin-internal`,
// then inserts a `<span data-pin-internal>` / `<iframe>` (often replacing the
// anchor entirely). Any one of these is proof the embed rendered. We treat the
// anchor losing `data-pin-do`, or an iframe/`[data-pin-internal]` node appearing
// in the embed container, as SUCCESS.
function isEmbedTransformed(
  container: HTMLElement,
  anchor: HTMLAnchorElement | undefined,
): boolean {
  // The anchor was processed in place (data-pin-do stripped) ...
  if (anchor && anchor.isConnected && !anchor.hasAttribute("data-pin-do")) return true;
  // ... or the anchor was swapped out for a Pinterest-rendered node ...
  if (anchor && !anchor.isConnected) return true;
  // ... or a rendered widget node now lives inside our container.
  return container.querySelector("iframe, [data-pin-internal], span[data-pin-id]") !== null;
}

/**
 * Renders a Pinterest moodboard — the consent-gated rich embed on EVERY device
 * (touch included), with an always-visible outbound fallback link below it:
 *
 * - The consent-gated rich embed: after the guest opts in, Pinterest's board
 *   widget renders inline, with an immediate "Loading board…" affordance on
 *   consent so the click never appears to do nothing.
 * - The always-visible outbound fallback link: rendered below the embed, it's a
 *   secondary "open on Pinterest" affordance when the board embeds and the
 *   primary way to reach the moodboard when the embed is absent (no consent,
 *   blocked, or a non-embeddable URL).
 *
 * Mobile note: the embed used to be desktop-only (a touch input-capability
 * split rendered a link-out card and never loaded the widget) because it
 * "repeatedly failed on mobile". That was dominated by unembeddable `pin.it`
 * short links being stored verbatim, since fixed (import-time resolution +
 * backfill). The success-detection MutationObserver + connection-scaled cutoff
 * make the embed self-healing on slow mobile, and the fallback link is the
 * safety net, so the split was removed — every device gets the same path.
 *
 * The embed uses Pinterest's documented embed widget pattern
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
  // True between the consent click and the embed either rendering or failing, so
  // the user gets IMMEDIATE "Loading board…" feedback instead of a dead, blank
  // slot. Cleared by the success observer / cutoff / onerror via the shared
  // markEmbedRendered + setEmbedFailed paths below.
  const [embedLoading, setEmbedLoading] = createSignal(false);
  let anchorRef: HTMLAnchorElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  // Injected script + fallback timer + success observer, tracked at component
  // scope so the single top-level onCleanup below can tear them down.
  let injectedScript: HTMLScriptElement | undefined;
  let timeoutId: number | undefined;
  let observer: MutationObserver | undefined;

  // Called the instant a successful transform is observed (or polled): cancel
  // the pending failure cutoff and stop observing, so a board that rendered is
  // never later hidden. Idempotent.
  function markEmbedRendered() {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    observer?.disconnect();
    observer = undefined;
    // The embed has rendered — drop the "Loading board…" affordance.
    setEmbedLoading(false);
  }

  // React to the shared, page-wide consent signal. This fires for all three
  // paths uniformly: (1) consent already persisted at mount, (2) this board's
  // own "Load Pinterest board" click, (3) another board on the page granting
  // consent (the shared signal flips, this effect re-runs and reveals us too).
  // Guarded so the tracker injects exactly once per mount. Runs on every device
  // now — the embed is no longer desktop-gated (see the module note above).
  createEffect(() => {
    if (consentGranted() && !injectedScript) {
      setEmbedFailed(false);
      injectEmbedScript();
    }
  });

  onCleanup(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    observer?.disconnect();
    injectedScript?.remove();
  });

  // Injects the tracker script. Only ever called after consent (persisted on
  // mount, or via an explicit user click on this or another board) — never on a
  // fresh, un-consented mount.
  function injectEmbedScript() {
    if (!isEmbeddablePinterestBoardUrl(props.url)) {
      // Not embeddable after all — nothing to load, so don't sit in a loading
      // state. The always-visible fallback link still surfaces the board.
      setEmbedLoading(false);
      return;
    }

    // Show the "Loading board…" affordance immediately, so the moment the guest
    // clicks "Load Pinterest content" they get feedback instead of a dead, blank
    // slot while the (potentially multi-second) script load + transform runs.
    // Cleared by markEmbedRendered (success) or the error/cutoff fallbacks.
    setEmbedLoading(true);

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    // No SRI is available for this third-party script (see component doc); the
    // consent gate is the compensating control. `no-referrer` trims what the
    // request leaks to Pinterest.
    script.referrerPolicy = "no-referrer";
    script.src = `https://assets.pinterest.com/js/pinit_main.js?_=${id}`;
    // A blocked / 404 / errored script is a definitive, fast failure.
    script.addEventListener("error", () => {
      markEmbedRendered(); // tear down observer + cutoff; we're going to fallback
      setEmbedFailed(true);
    });
    document.body.appendChild(script);
    injectedScript = script;

    // SUCCESS DETECTION (replaces the old fixed-2.5s race). Pinterest's transform
    // can finish well after a couple of seconds on mobile, so instead of blindly
    // declaring failure on a timer, we OBSERVE the embed container for the
    // transform and only fall back if it never arrives. If it's somehow already
    // transformed (script cached + synchronous), short-circuit immediately.
    if (containerRef) {
      if (isEmbedTransformed(containerRef, anchorRef)) {
        markEmbedRendered();
      } else {
        observer = new MutationObserver(() => {
          if (containerRef && isEmbedTransformed(containerRef, anchorRef)) {
            markEmbedRendered();
          }
        });
        observer.observe(containerRef, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-pin-do", "data-pin-internal"],
        });
      }
    }

    // Failure cutoff. Generous + connection-scaled so mobile is never falsely
    // failed (see EMBED_TIMEOUT_* docs). The observer above cancels this the
    // moment the embed renders, so a working board never waits this out — the
    // cutoff only bounds the blank slot for a board that genuinely never renders
    // (e.g. a downstream pidgets/CDN block that emits no script `error` event).
    timeoutId = window.setTimeout(() => {
      timeoutId = undefined;
      // Final re-check: only fall back if nothing rendered by the cutoff.
      if (containerRef && isEmbedTransformed(containerRef, anchorRef)) {
        markEmbedRendered();
        return;
      }
      observer?.disconnect();
      observer = undefined;
      setEmbedLoading(false);
      setEmbedFailed(true);
    }, resolveEmbedTimeoutMs());
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
      {/* The consent-gated rich embed with the always-visible fallback link
          rendered BELOW it. Shown on EVERY device now — the prior desktop-only
          touch split is gone (see the module note at the top of this file). */}
      <>
        {/* The consent prompt + embed anchor only exist when the URL is an */}
        {/* embeddable board shape. A safe-but-not-embeddable link (pin.it short */}
        {/* link, bare pin/profile) shows only the fallback link below and nothing else. */}
        <Show when={embeddable()}>
          <Show
            when={consentGranted() && !embedFailed()}
            fallback={
              // Default state: opt-in consent affordance. No script has loaded.
              <div class="font-body text-fg/70 mt-2 flex flex-col items-center gap-2 text-center text-[0.72rem]">
                <p>
                  Load Pinterest board? This embeds content from Pinterest, a third party that may
                  set cookies and collect usage data. Your choice is remembered for this site. See
                  our{" "}
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
            {/* IMMEDIATE click feedback: the moment consent is granted we show a
                "Loading board…" affordance over/above the (still-empty) embed
                anchor, so the user never stares at a dead, blank slot between
                their click and the multi-second script load + transform. The
                anchor itself must still mount (Pinterest's script scans for it),
                so this overlays it rather than replacing it. */}
            <Show when={embedLoading()}>
              <div
                class="font-body text-fg/70 mt-2 flex items-center justify-center gap-2 text-center text-[0.72rem]"
                role="status"
                aria-live="polite"
              >
                <span
                  class="border-gold/40 border-t-gold inline-block h-4 w-4 animate-spin rounded-full border-2"
                  aria-hidden="true"
                />
                <span>Loading board…</span>
              </div>
            </Show>

            {/* The Pinterest widget renders a fixed-width iframe (data-pin-board-
                width). On narrow viewports that pixel width can exceed the modal's
                content box, so the embed lives in a max-width, horizontally-
                scrollable, centred box: any overflow scrolls *within* this box
                instead of pushing the whole page sideways. */}
            <div class="-mx-6 mt-2 overflow-x-auto px-6">
              {/* containerRef wraps the anchor: this is the subtree the success
                  MutationObserver watches. Pinterest inserts its iframe/span here
                  (as a sibling) or replaces the anchor in place — either way the
                  transform happens inside this node. `min-w-min` + `justify-center`
                  size to the rendered iframe's intrinsic width and centre it; the
                  overflow scrolls in the outer box, so the inserted iframe is never
                  zero-boxed or clipped on a narrow viewport (#173 behaviour kept). */}
              <div ref={containerRef} class="flex min-w-min justify-center">
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

        {/* The outbound fallback link is ALWAYS present whenever the URL is a safe */}
        {/* Pinterest link — even if the embed is blocked, slow, or the URL isn't an */}
        {/* embeddable board shape — so every guest can always reach the moodboard. */}
        {/* It renders BELOW the embed area: when the board embeds the link is a */}
        {/* secondary "open on Pinterest" affordance under it; when the embed is */}
        {/* absent (no consent, blocked, or non-embeddable URL) it is the primary */}
        {/* way to reach the moodboard. */}
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
      </>
    </Show>
  );
}
