import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { isValidPinterestUrl } from "./pinterest";

interface PinterestBoardProps {
  url: string;
  eventName: string;
}

// Stable per-instance id so the anchor and the cache-busted script tag line up.
let nextId = 0;
const nextAnchorId = () => `pin-board-${++nextId}`;

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
 * with a graceful fallback to a plain outbound link when a tracker blocker
 * stops the embed from rendering. About 10–30% of visitors run a privacy
 * extension that blocks Pinterest's tracker script outright, so the fallback
 * is the visible UX for them.
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
  const [embedFailed, setEmbedFailed] = createSignal(false);
  let anchorRef: HTMLAnchorElement | undefined;

  onMount(() => {
    if (!isValidPinterestUrl(props.url)) return;

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.src = `https://assets.pinterest.com/js/pinit_main.js?_=${id}`;
    script.onerror = () => setEmbedFailed(true);
    document.body.appendChild(script);

    // Even if the script loads, a downstream block (pidgets API, image CDN) can
    // leave the anchor untransformed. Pinit_main marks processed anchors with
    // `data-pin-internal`; if our anchor still carries the original `data-pin-do`
    // after the grace period, the embed failed.
    const timeoutId = window.setTimeout(() => {
      if (anchorRef?.isConnected && anchorRef.hasAttribute("data-pin-do")) {
        setEmbedFailed(true);
      }
    }, EMBED_TIMEOUT_MS);
    onCleanup(() => {
      window.clearTimeout(timeoutId);
      script.remove();
    });
  });

  return (
    <Show when={isValidPinterestUrl(props.url)}>
      <Show
        when={embedFailed()}
        fallback={
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
        }
      >
        <a
          href={props.url}
          target="_blank"
          rel="noopener noreferrer"
          class="border-gold font-body text-gold hover:bg-gold hover:text-bg mt-2 inline-block rounded-sm border px-5 py-2.5 text-[0.78rem] tracking-[0.12em] uppercase transition-colors duration-200"
        >
          View moodboard on Pinterest ↗
        </a>
      </Show>
    </Show>
  );
}
