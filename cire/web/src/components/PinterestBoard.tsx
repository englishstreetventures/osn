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

// Touch/coarse-pointer detection. The rich consent-gated embed (and the
// third-party tracker it needs) is DESKTOP-ONLY: on touch devices Pinterest's
// `pinit_main.js` widget is slow and unreliable (the whole reason this gate
// "repeatedly failed on mobile"), and the only thing the gate exists to protect
// is that tracker. So on touch we don't load the tracker, don't show the gate,
// and don't show the embed at all — we surface a single, prominent, instantly-
// working "View moodboard on Pinterest" card instead. No tracker ⇒ no consent
// needed ⇒ no gate ⇒ nothing to fail.
//
// We detect by CAPABILITY, not UA sniffing: `(hover: none) and (pointer:
// coarse)` is the standard "primary input is a finger" query (phones/tablets),
// backed up by a narrow-viewport check so a small touch device with an unusual
// pointer profile still gets the reliable link-out. A desktop with a touchscreen
// (hover + fine pointer present) keeps the rich embed. Evaluated once on the
// client; in SSR / a test env without `matchMedia` we default to the safe
// desktop path only when we can positively confirm hover+fine, else treat as the
// embed path — but the helper below is conservative and self-contained so the
// Pinterest component owns its own capability check (no shared util).
const TOUCH_VIEWPORT_MAX_PX = 820;

function detectIsTouchPrimary(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const mm = window.matchMedia;
    if (typeof mm === "function") {
      // The canonical "no hover, coarse pointer" query: a finger is the primary
      // input. This is the strongest signal and the one we trust first.
      if (mm("(hover: none) and (pointer: coarse)").matches) return true;
      // Belt-and-braces: a coarse primary pointer on a narrow viewport, even if
      // the device also reports some hover capability (e.g. a 2-in-1 in tablet
      // mode), is still a touch experience for the unreliable Pinterest widget.
      if (mm("(pointer: coarse)").matches && window.innerWidth <= TOUCH_VIEWPORT_MAX_PX) {
        return true;
      }
    }
    return false;
  } catch {
    // matchMedia unavailable / threw — default to the (desktop) embed path; it
    // still degrades gracefully to the always-visible link if the embed fails.
    return false;
  }
}

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

// Test-only override for the touch/desktop capability decision. happy-dom's
// `matchMedia` always reports `matches: false`, so without this every test would
// take the desktop embed path and the mobile link-out path would be untestable.
// `null` (the default) means "use the real `detectIsTouchPrimary()` capability
// check"; a boolean forces that path.
let touchOverrideForTest: boolean | null = null;

/**
 * Test-only: force the touch (`true`) or desktop (`false`) path, or restore real
 * capability detection (`null`). Lets a test exercise the mobile link-out path
 * and the desktop embed path deterministically under happy-dom.
 */
export function setPinterestTouchForTest(value: boolean | null): void {
  touchOverrideForTest = value;
}

function resolveIsTouchPrimary(): boolean {
  return touchOverrideForTest ?? detectIsTouchPrimary();
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
 * Renders a Pinterest moodboard, splitting by input capability:
 *
 * - TOUCH / MOBILE (`(hover: none) and (pointer: coarse)`, or a coarse pointer on
 *   a narrow viewport): a single, prominent, instantly-working "View moodboard on
 *   Pinterest" card that opens the board in a new tab. The rich embed widget is
 *   slow + unreliable on touch (it "repeatedly failed on mobile"), and the ONLY
 *   reason the consent gate exists is the third-party tracker that embed needs —
 *   so on touch we load NO tracker, show NO consent gate, and render NO embed.
 *   No tracker ⇒ no consent needed ⇒ no gate ⇒ nothing to fail. This is now the
 *   primary mobile experience, so the card is large, not a tiny text link.
 *
 * - DESKTOP (hover + fine pointer): the consent-gated rich embed below, with an
 *   always-visible outbound fallback link, plus an immediate "Loading board…"
 *   affordance on consent so the click never appears to do nothing.
 *
 * The embed uses Pinterest's documented embed widget pattern
 * (https://developers.pinterest.com/docs/web-features/widgets/#board-widget),
 * behind a persisted, page-wide opt-in consent gate, with a graceful fallback
 * to a plain outbound link whenever the embed isn't shown (no consent, invalid
 * URL, or a tracker blocker stopping the embed from rendering).
 *
 * Consent gate (S-H3 / C-H3), desktop-only: `assets.pinterest.com/js/pinit_main.js` is a
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
  // Touch vs desktop is fixed for this mount: a guest doesn't switch input modes
  // mid-board. Computed once so the JSX (and the consent-gate decision) is stable.
  const isTouch = resolveIsTouchPrimary();
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
  // Guarded so the tracker injects exactly once per mount.
  //
  // `!isTouch` is the hard guard that keeps the third-party tracker DESKTOP-ONLY:
  // a touch guest never injects `pinit_main.js` even if consent was persisted
  // from an earlier desktop visit (shared localStorage), because the embed is
  // unreliable on touch and the link-out below is the better experience there.
  createEffect(() => {
    if (!isTouch && consentGranted() && !injectedScript) {
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
      {/* TOUCH / MOBILE PATH. The rich embed (and the third-party tracker it
          needs) is desktop-only — it's slow + unreliable on touch and that's the
          ONLY thing the consent gate protects. So on touch we show a single,
          prominent, instantly-working card that opens the board in a new tab. No
          tracker is loaded, so no consent is needed and there is no gate to fail.
          This is the PRIMARY mobile experience, hence the larger, full-width card
          rather than a small text link. */}
      <Show when={isTouch}>
        <a
          href={props.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View the moodboard for ${props.eventName} on Pinterest (opens in a new tab)`}
          class="border-gold bg-gold/5 hover:bg-gold hover:text-bg font-body text-gold active:bg-gold active:text-bg mt-2 flex flex-col items-center gap-1 rounded-sm border px-5 py-4 text-center transition-colors duration-200"
        >
          <span class="text-[0.85rem] tracking-[0.14em] uppercase">
            View moodboard on Pinterest ↗
          </span>
          <span class="text-fg/60 font-body text-[0.7rem] tracking-normal normal-case">
            Opens the inspiration board on Pinterest in a new tab
          </span>
        </a>
      </Show>

      {/* DESKTOP PATH (hover + fine pointer): the consent-gated rich embed with
          the always-visible fallback link rendered BELOW it. */}
      <Show when={!isTouch}>
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
      </Show>
    </Show>
  );
}
