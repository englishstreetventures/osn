import { Show } from "solid-js";

import { resolveMapsEmbedUrl, resolveMapsUrl, venueLine } from "./event-details";
import type { EventSummary } from "./types";

interface MapPreviewProps {
  event: EventSummary;
}

/**
 * Map preview for a wedding event's "Where" section.
 *
 * Two render paths share one footer (venue line + "Open in Maps" action):
 *
 *  - **Real map** — when `PUBLIC_GOOGLE_MAPS_EMBED_KEY` is configured at build
 *    time AND the event has a venue address, the top of the card is a Google
 *    Maps Embed API `place` iframe keyed on the free-text address (no lat/lng,
 *    no geocoding, no schema change). The key is referrer-restricted at the
 *    Maps Platform console, which is what makes baking it into static HTML safe.
 *    The iframe is sandboxed and uses a strict referrer policy so the
 *    slug-bearing invite path is never leaked to Google (see S-L1 / S-L2).
 *
 *  - **CSS card (fallback)** — when no key is configured, or there is no address
 *    to query, the top is a self-contained CSS-drawn "cartographic" card (gold
 *    contour rings + street grid + marker pin) that ships no image, needs no
 *    secret, and makes no network request. This keeps the page working before
 *    any key exists, so shipping the key is a pure enhancement.
 *
 * The whole component renders nothing when there is no usable maps target at all
 * (no `mapsUrl` and no address) — no dead button, no broken tile.
 *
 * Security: the address is the only interpolated value and is always
 * `encodeURIComponent`-escaped (in `resolveMapsEmbedUrl`); organiser text never
 * reaches the iframe URL or the DOM unescaped, and the key is never logged.
 */
export function MapPreview(props: MapPreviewProps) {
  const venue = () => venueLine(props.event);
  const mapsHref = () => resolveMapsUrl(props.event);
  // Vite statically replaces `import.meta.env.PUBLIC_*` at build time for the
  // island bundle, so the key bakes in (or is absent) just like the API URL.
  const embedSrc = () =>
    resolveMapsEmbedUrl(props.event, import.meta.env.PUBLIC_GOOGLE_MAPS_EMBED_KEY);

  return (
    <Show when={mapsHref()}>
      {(href) => (
        <Show when={embedSrc()} fallback={<MapCard href={href()} venue={venue()} />}>
          {(src) => <MapEmbed href={href()} venue={venue()} src={src()} />}
        </Show>
      )}
    </Show>
  );
}

/**
 * The real Google Maps Embed iframe + the shared footer. The iframe captures
 * pointer events, so (unlike the CSS card) the actionable "open in maps" link
 * lives in the footer rather than wrapping the whole card.
 */
function MapEmbed(props: { href: string; venue: string | null; src: string }) {
  const title = () => `Map of ${props.venue ?? "the venue"}`;

  return (
    <div class="border-border bg-bg overflow-hidden rounded-md border">
      <iframe
        src={props.src}
        title={title()}
        loading="lazy"
        // S-L2: strict-origin matches the page-level referrer policy
        // (`index.astro` sets `strict-origin-when-cross-origin` to keep the
        // slug-/`?code=`-bearing path out of cross-origin Referer headers).
        // Google's referrer key-restriction only needs the origin, which this
        // still sends, so the embed and the key restriction keep working.
        referrerpolicy="strict-origin-when-cross-origin"
        // S-L1: least-privilege sandbox. The Maps Embed needs scripts +
        // same-origin (to google.com) + popups (the "View larger map" link);
        // withholding allow-top-navigation/allow-forms removes the frame's
        // ability to navigate the guest page or submit forms.
        sandbox="allow-scripts allow-same-origin allow-popups"
        // Fully constrained box (h-36 = 9rem tall, full-width) matching the
        // CSS-card path, so the iframe reserves its space up front and never
        // shifts layout as the embed loads.
        class="block h-36 w-full border-0"
      />
      <FooterRow href={props.href} venue={props.venue} />
    </div>
  );
}

/** The CSS-drawn cartographic fallback card; the whole card is the maps link. */
function MapCard(props: { href: string; venue: string | null }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      class="group border-border bg-bg focus-visible:ring-gold/60 relative block overflow-hidden rounded-md border focus:outline-none focus-visible:ring-2"
      aria-label={`Open ${props.venue ?? "the venue"} in maps`}
    >
      {/* Decorative cartographic backdrop — contour rings + street grid,
          drawn entirely in CSS so it ships no image and needs no key. */}
      <div
        aria-hidden="true"
        class="relative h-36 w-full motion-safe:transition-transform motion-safe:duration-500 motion-safe:group-hover:scale-[1.03]"
        style={{
          "background-color": "var(--color-surface)",
          "background-image": [
            // concentric "contour" glow around the pin
            "radial-gradient(circle at 50% 58%, oklch(74.99% 0.0854 82.08 / 0.16) 0%, transparent 42%)",
            // diagonal "roads"
            "repeating-linear-gradient(38deg, oklch(85.51% 0.069 144.94 / 0.07) 0 1px, transparent 1px 26px)",
            "repeating-linear-gradient(-52deg, oklch(85.51% 0.069 144.94 / 0.07) 0 1px, transparent 1px 34px)",
            // faint base grid
            "repeating-linear-gradient(0deg, oklch(85.51% 0.069 144.94 / 0.04) 0 1px, transparent 1px 22px)",
            "repeating-linear-gradient(90deg, oklch(85.51% 0.069 144.94 / 0.04) 0 1px, transparent 1px 22px)",
          ].join(", "),
        }}
      >
        {/* Marker pin, centred over the contour glow. */}
        <div class="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-[60%] flex-col items-center">
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-gold drop-shadow-[0_2px_6px_oklch(0%_0_0/0.45)]"
            aria-hidden="true"
          >
            <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
            <circle cx="12" cy="10" r="2.4" />
          </svg>
          {/* pin shadow ellipse on the "ground" */}
          <span class="bg-gold/30 mt-0.5 h-1 w-3 rounded-full blur-[1px]" />
        </div>
      </div>

      <FooterRow href={props.href} venue={props.venue} interactive={false} />
    </a>
  );
}

/**
 * Shared footer: venue line + the "Open in Maps" affordance. In the CSS-card
 * path the enclosing `<a>` is the link, so the action is a non-interactive
 * `<span>` (`interactive={false}`); in the iframe path it is itself the link.
 */
function FooterRow(props: { href: string; venue: string | null; interactive?: boolean }) {
  const isLink = () => props.interactive !== false;

  return (
    <div class="border-border/70 bg-surface-raised flex items-center justify-between gap-3 border-t px-4 py-3">
      <Show
        when={props.venue}
        fallback={<span class="font-body text-text-muted text-[0.8rem] italic">View on map</span>}
      >
        {(line) => (
          <span class="font-body text-text-muted min-w-0 flex-1 truncate text-left text-[0.82rem]">
            {line()}
          </span>
        )}
      </Show>
      <Show
        when={isLink()}
        fallback={
          <span class="border-gold font-body text-gold group-hover:bg-gold group-hover:text-bg inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-3.5 py-1.5 text-[0.72rem] tracking-[0.12em] uppercase transition-colors duration-200">
            Open in Maps
            <OpenIcon />
          </span>
        }
      >
        <a
          href={props.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${props.venue ?? "the venue"} in maps`}
          class="border-gold font-body text-gold hover:bg-gold hover:text-bg focus-visible:ring-gold/60 inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-3.5 py-1.5 text-[0.72rem] tracking-[0.12em] uppercase transition-colors duration-200 focus:outline-none focus-visible:ring-2"
        >
          Open in Maps
          <OpenIcon />
        </a>
      </Show>
    </div>
  );
}

function OpenIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}
