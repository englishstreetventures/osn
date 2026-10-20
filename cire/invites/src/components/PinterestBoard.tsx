import Button, { buttonClass } from "@cire/ui/button";
import { type Accessor, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";

import { grantCategory } from "../lib/consent/store";
import { ConsentGate } from "./consent/ConsentGate";
import { isEmbeddablePinterestBoardUrl, isSafePinterestLinkUrl } from "./pinterest";

interface PinterestBoardProps {
  url: string;
  eventName: string;
}

/**
 * Where the rich embed stands. `idle` means no embed is mounted at all — an
 * un-embeddable URL, or Pinterest moodboards not switched on. `failed` means
 * the embed was tried and did not render. The moodboard block (and its link
 * out to Pinterest) shows in exactly those two states, from one place each:
 * see `PinterestBoard`.
 */
type EmbedStatus = "idle" | "loading" | "rendered" | "failed";

interface PinterestEmbedProps extends PinterestBoardProps {
  status: Accessor<EmbedStatus>;
  setStatus: (status: EmbedStatus) => void;
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
// MutationObserver, the connection-scaled failure cutoff, and the outbound
// fallback link — none of which was ever about consent.

// NOTE (mobile embed re-enabled): the consent-gated rich embed renders on ALL
// devices, touch included. It was previously desktop-only because the Pinterest
// widget "repeatedly failed on mobile" — but the dominant cause of those
// failures was unembeddable `pin.it` short links being stored verbatim (boards
// are now resolved to canonical `/user/board` URLs at import time, and the live
// data was backfilled), not a touch-specific defect. The success-detection
// MutationObserver + connection-scaled failure cutoff already make the embed
// self-healing on slow mobile networks, and the outbound fallback link that
// replaces the embed on failure is the safety net if a board still doesn't render.

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
 * (touch included), or the moodboard block when the embed is not showing:
 *
 * - The consent-gated rich embed: once the guest has switched on Pinterest
 *   moodboards, Pinterest's board widget renders inline.
 * - The moodboard block (`MoodboardBlock`), with its "Open on Pinterest" link:
 *   shown whenever no board is on screen or on its way — not switched on, a
 *   non-embeddable URL, or an embed that errored or timed out — and hidden
 *   while the embed loads or once it has rendered. Because it shows for a
 *   refusal, refusing consent costs the guest nothing they cannot get another
 *   way — the moodboard stays one tap away either side of the decision, which
 *   is what makes the choice real.
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
 * gates the outbound link, so the moodboard stays
 * reachable even when the URL is a `pin.it` short link or some other shape the
 * board widget can't embed. `isEmbeddablePinterestBoardUrl` (the strict
 * `/user/board` shape) is the stricter gate before the URL ever lands in the
 * embed script or the `<a data-pin-do>` anchor.
 */
export function PinterestBoard(props: PinterestBoardProps) {
  // Whether this URL can be rendered as an embedded board widget at all. A safe
  // Pinterest link that isn't an embeddable board shape (a `pin.it` short link,
  // a bare pin/profile) still gets the block with its link — it just never
  // offers "Show it here" or mounts the gate, because there is nothing to
  // consent TO: no request to Pinterest would ever be made.
  const embeddable = () => isEmbeddablePinterestBoardUrl(props.url);
  const [status, setStatus] = createSignal<EmbedStatus>("idle");

  // Exactly one moodboard block renders in any state, and so exactly one link:
  //  - not embeddable: the block, outside any gate (no gate is mounted);
  //  - embeddable, not switched on: the block with the offer, as the gate's own
  //    fallback;
  //  - switched on and failed: the "couldn't load" block, outside the gate,
  //    because the gate is showing its (now empty) children;
  //  - switched on and loading or rendered: no block.
  return (
    <Show when={isSafePinterestLinkUrl(props.url)}>
      <>
        <Show when={embeddable()} fallback={<MoodboardBlock url={props.url} state="link" />}>
          <ConsentGate
            category="pinterest"
            vendor="pinterest"
            fallback={<MoodboardBlock url={props.url} state="offer" />}
          >
            <PinterestEmbed
              url={props.url}
              eventName={props.eventName}
              status={status}
              setStatus={setStatus}
            />
          </ConsentGate>
          <Show when={status() === "failed"}>
            <MoodboardBlock url={props.url} state="failed" />
          </Show>
        </Show>

        {/* A failed embed takes its "Loading board…" status region with it, so */}
        {/* the announcement that the link has appeared lives here, mounted */}
        {/* throughout, where a screen reader is already listening. */}
        <div class="sr-only" aria-live="polite" aria-atomic="true">
          {status() === "failed" ? "The board could not load. Open it on Pinterest instead." : ""}
        </div>
      </>
    </Show>
  );
}

/**
 * The moodboard as one block: what it is, a link out to it, and — while
 * Pinterest moodboards are switched off for an embeddable board — the offer to
 * show it here, with what that costs said beside the button.
 *
 * "Show it here" switches on the `pinterest` category, which is one record for
 * the whole guest site (one cookie, `Path=/`), so the copy says it holds for
 * every invite opened in this browser rather than for this one. There is no
 * "Privacy choices" button: the footer's standing control is the route to
 * every switch at once.
 */
function MoodboardBlock(props: { url: string; state: "link" | "offer" | "failed" }) {
  const costId = createUniqueId();

  return (
    <div class="border-border rounded-md border px-4 py-4">
      <p class="font-body text-text-muted text-ui-base leading-ui-normal font-light">
        {props.state === "failed"
          ? "The couple's moodboard for this event couldn't load here."
          : "The couple's moodboard for this event is on Pinterest."}
      </p>
      <Show when={props.state === "offer"}>
        <p id={costId} class="font-body text-text-muted text-ui-sm mt-1.5 leading-relaxed">
          Showing it here switches on Pinterest moodboards for invites you open in this browser.
          They load from Pinterest's servers, which lets Pinterest see your IP address and browser.
        </p>
      </Show>
      <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        <a
          href={props.url}
          target="_blank"
          rel="noopener noreferrer"
          class={`${buttonClass({ variant: "link", size: "md" })} min-h-11`}
        >
          Open on Pinterest
          <span aria-hidden="true">↗</span>
        </a>
        <Show when={props.state === "offer"}>
          <Button
            variant="quiet"
            size="sm"
            class="min-h-11"
            aria-describedby={costId}
            onClick={() => grantCategory("pinterest")}
          >
            Show it here
          </Button>
        </Show>
      </div>
    </div>
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
function PinterestEmbed(props: PinterestEmbedProps) {
  const id = nextAnchorId();
  let anchorRef: HTMLAnchorElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  // Injected script + fallback timer + success observer, tracked at component
  // scope so the single onCleanup below can tear them down.
  let injectedScript: HTMLScriptElement | undefined;
  let timeoutId: number | undefined;
  let observer: MutationObserver | undefined;

  // Cancel the pending failure cutoff and stop observing, so the outcome that
  // was just decided is never overturned. Idempotent.
  function stopWatching() {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    observer?.disconnect();
    observer = undefined;
  }

  // Called the instant a successful transform is observed, so a board that
  // rendered is never later hidden.
  function markEmbedRendered() {
    stopWatching();
    props.setStatus("rendered");
  }

  onMount(() => {
    injectEmbedScript();
  });

  onCleanup(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    observer?.disconnect();
    injectedScript?.remove();
    // No embed is mounted any more (consent withdrawn, or the sheet closed), so
    // the parent's moodboard block is the route to the board again.
    props.setStatus("idle");
  });

  function injectEmbedScript() {
    // Defensive: the parent only mounts us for an embeddable board URL, but the
    // strict shape is the gate that keeps organiser-supplied text out of the
    // third-party script's input, so it is re-checked at the point of use.
    if (!isEmbeddablePinterestBoardUrl(props.url)) {
      props.setStatus("idle");
      return;
    }

    // Show the "Loading board…" affordance immediately, so the guest gets
    // feedback rather than a dead, blank slot while the (potentially
    // multi-second) script load + transform runs. Cleared by markEmbedRendered
    // (success) or the error/cutoff fallbacks.
    props.setStatus("loading");

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
      stopWatching();
      props.setStatus("failed");
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
      props.setStatus("failed");
    }, resolveEmbedTimeoutMs());
  }

  return (
    // On failure the embed slot collapses to nothing and the parent's
    // "couldn't load" block takes its place. It deliberately does NOT reinstate a consent
    // prompt: consent was already given, and re-asking for permission we hold
    // would misrepresent a Pinterest-side failure as the guest's decision.
    <Show when={props.status() !== "failed"}>
      {/* IMMEDIATE feedback: a "Loading board…" affordance above the (still-empty)
          embed anchor, so the guest never stares at a dead, blank slot between
          allowing the content and the multi-second script load + transform. The
          anchor itself must still mount (Pinterest's script scans for it), so
          this sits above it rather than replacing it. */}
      <Show when={props.status() === "loading"}>
        <div
          class="font-body text-text-muted text-ui-xs mt-2 flex items-center justify-center gap-2 text-center"
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
