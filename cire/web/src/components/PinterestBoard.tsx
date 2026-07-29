import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { ConsentGate } from "./consent/ConsentGate";
import { isEmbeddablePinterestBoardUrl, isSafePinterestLinkUrl } from "./pinterest";

interface PinterestBoardProps {
  url: string;
  eventName: string;
}

// Stable per-instance id so the anchor and the cache-busted script tag line up.
let nextId = 0;
const nextAnchorId = () => `pin-board-${++nextId}`;

// CONSENT (moved out, 2026-07-29): this component used to own the site's only
// consent story — its own `cire:pinterest-consent` localStorage key, its own
// module-level signal, its own prompt and its own copy. That made Pinterest the
// one third party with a gate, for no better reason than that it was the one
// someone had written a gate for; the Google Maps venue embed made an
// equivalent transfer to an equivalent US recipient with no gate at all.
//
// Consent now lives in `lib/consent/` and is granted per CATEGORY, and this
// component is an ordinary consumer of `<ConsentGate>` like any other. What
// survives unchanged is the interesting part — the success-detecting
// MutationObserver, the connection-scaled failure cutoff, and the always-visible
// fallback link — none of which was ever about consent.

// NOTE (mobile embed re-enabled): the consent-gated rich embed renders on ALL
// devices, touch included. It was previously desktop-only because the Pinterest
// widget "repeatedly failed on mobile" — but the dominant cause of those
// failures was unembeddable `pin.it` short links being stored verbatim (boards
// are now resolved to canonical `/user/board` URLs at import time, and the live
// data was backfilled), not a touch-specific defect. The success-detection
// MutationObserver + connection-scaled failure cutoff already make the embed
// self-healing on slow mobile networks, and the always-visible fallback link
// below the embed is the safety net if a board still doesn't render.

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
 * - The consent-gated rich embed: once the guest has allowed third-party
 *   content, Pinterest's board widget renders inline.
 * - The always-visible outbound fallback link: rendered below the embed, it's a
 *   secondary "open on Pinterest" affordance when the board embeds and the
 *   primary way to reach the moodboard when the embed is absent (no consent,
 *   blocked, or a non-embeddable URL). This is why refusing consent costs the
 *   guest nothing they cannot get another way — the moodboard stays one tap
 *   away either side of the decision, which is what makes the choice real.
 *
 * The embed uses Pinterest's documented embed widget pattern
 * (https://developers.pinterest.com/docs/web-features/widgets/#board-widget),
 * behind the site-wide `embeds` consent category (see `lib/consent/`).
 *
 * Why consent at all (S-H3 / C-H3): `assets.pinterest.com/js/pinit_main.js` is
 * a third-party tracker that ships guest IP / UA / behaviour to Pinterest (an
 * undeclared subprocessor) with no SRI hash available. Loading it on mount
 * would be a non-consensual transfer under ePrivacy.
 *
 * SRI: Pinterest publishes no stable Subresource-Integrity hash for
 * pinit_main.js (the IIFE is rolled frequently and the URL is cache-busted),
 * so we can't pin it. `referrerpolicy="no-referrer"` trims the data we leak in
 * the request, and the consent gate is the compensating control for the missing
 * integrity guarantee.
 *
 * URL safety + graceful degradation: two separate gates (see `pinterest.ts`).
 * `isSafePinterestLinkUrl` (https + Pinterest-host allowlist, loose on path)
 * gates the always-visible outbound fallback link, so the moodboard stays
 * reachable even when the URL is a `pin.it` short link or some other shape the
 * board widget can't embed. `isEmbeddablePinterestBoardUrl` (the strict
 * `/user/board` shape) is the stricter gate before the URL ever lands in the
 * embed script or the `<a data-pin-do>` anchor.
 */
export function PinterestBoard(props: PinterestBoardProps) {
  // Whether this URL can be rendered as an embedded board widget at all. A safe
  // Pinterest link that isn't an embeddable board shape (a `pin.it` short link,
  // a bare pin/profile) still gets the always-visible fallback link below — it
  // just never shows the consent placeholder or the embed anchor, because there
  // is nothing to consent TO: no request to Pinterest would ever be made.
  const embeddable = () => isEmbeddablePinterestBoardUrl(props.url);

  return (
    <Show when={isSafePinterestLinkUrl(props.url)}>
      <>
        <Show when={embeddable()}>
          <ConsentGate category="embeds" vendor="pinterest">
            <PinterestEmbed url={props.url} eventName={props.eventName} />
          </ConsentGate>
        </Show>

        {/* The outbound fallback link is ALWAYS present whenever the URL is a safe */}
        {/* Pinterest link — even if the embed is blocked, slow, refused, or the URL */}
        {/* isn't an embeddable board shape — so every guest can always reach the */}
        {/* moodboard. It renders BELOW the embed area: when the board embeds the link */}
        {/* is a secondary "open on Pinterest" affordance under it; otherwise it is the */}
        {/* primary way to reach the moodboard. */}
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

/**
 * The tracker-loading half, mounted ONLY once consent has been granted.
 *
 * Splitting this out of `PinterestBoard` is what makes the gate load-bearing
 * rather than cosmetic: `<ConsentGate>` doesn't render its children at all
 * while consent is absent, so this component's `onMount` — and with it the
 * injection of `pinit_main.js` — cannot run. A version that mounted always and
 * merely hid its output behind a CSS class would have made the request anyway,
 * which is the failure mode this arrangement forecloses.
 */
function PinterestEmbed(props: PinterestBoardProps) {
  const id = nextAnchorId();
  const [embedFailed, setEmbedFailed] = createSignal(false);
  // True between mount and the embed either rendering or failing, so the guest
  // gets IMMEDIATE "Loading board…" feedback after allowing the content instead
  // of a dead, blank slot.
  const [embedLoading, setEmbedLoading] = createSignal(false);
  let anchorRef: HTMLAnchorElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  // Injected script + fallback timer + success observer, tracked at component
  // scope so the single onCleanup below can tear them down.
  let injectedScript: HTMLScriptElement | undefined;
  let timeoutId: number | undefined;
  let observer: MutationObserver | undefined;

  // Called the instant a successful transform is observed: cancel the pending
  // failure cutoff and stop observing, so a board that rendered is never later
  // hidden. Idempotent.
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

  onMount(() => {
    injectEmbedScript();
  });

  onCleanup(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    observer?.disconnect();
    injectedScript?.remove();
  });

  function injectEmbedScript() {
    // Defensive: the parent only mounts us for an embeddable board URL, but the
    // strict shape is the gate that keeps organiser-supplied text out of the
    // third-party script's input, so it is re-checked at the point of use.
    if (!isEmbeddablePinterestBoardUrl(props.url)) {
      setEmbedLoading(false);
      return;
    }

    // Show the "Loading board…" affordance immediately, so the guest gets
    // feedback rather than a dead, blank slot while the (potentially
    // multi-second) script load + transform runs. Cleared by markEmbedRendered
    // (success) or the error/cutoff fallbacks.
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

  return (
    // On failure the embed slot collapses to nothing and the parent's outbound
    // link carries the moodboard. It deliberately does NOT reinstate a consent
    // prompt: consent was already given, and re-asking for permission we hold
    // would misrepresent a Pinterest-side failure as the guest's decision.
    <Show when={!embedFailed()}>
      {/* IMMEDIATE feedback: a "Loading board…" affordance above the (still-empty)
          embed anchor, so the guest never stares at a dead, blank slot between
          allowing the content and the multi-second script load + transform. The
          anchor itself must still mount (Pinterest's script scans for it), so
          this sits above it rather than replacing it. */}
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

      {/* The Pinterest widget renders a fixed-width iframe (data-pin-board-width).
          On narrow viewports that pixel width can exceed the modal's content box,
          so the embed lives in a max-width, horizontally-scrollable, centred box:
          any overflow scrolls *within* this box instead of pushing the whole page
          sideways. */}
      <div class="-mx-6 mt-2 overflow-x-auto px-6">
        {/* containerRef wraps the anchor: this is the subtree the success
            MutationObserver watches. Pinterest inserts its iframe/span here (as a
            sibling) or replaces the anchor in place — either way the transform
            happens inside this node. `min-w-min` + `justify-center` size to the
            rendered iframe's intrinsic width and centre it; the overflow scrolls
            in the outer box, so the inserted iframe is never zero-boxed or
            clipped on a narrow viewport (#173 behaviour kept). */}
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
  );
}
