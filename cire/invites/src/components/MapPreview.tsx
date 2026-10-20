import { buttonClass } from "@cire/ui/button";
import { Show } from "solid-js";

import { ConsentGate } from "./consent/ConsentGate";
import { resolveMapsEmbedUrl, resolveMapsUrl, venueLine } from "./event-details";
import type { EventSummary } from "./types";

interface MapPreviewProps {
  event: EventSummary;
}

/**
 * The "Where" row of the event sheet's key facts: the venue address, a compact
 * map, and an "Open in maps" link, top to bottom.
 *
 * The map has two forms:
 *
 *  - **Real map** — when `PUBLIC_GOOGLE_MAPS_EMBED_KEY` is configured at build
 *    time AND the event has a venue address AND the guest has switched on
 *    Google Maps, a Google Maps Embed API `place` iframe keyed on the free-text
 *    address (no lat/lng, no geocoding, no schema change). The key is
 *    referrer-restricted at the Maps Platform console, which is what makes
 *    baking it into static HTML safe. The iframe is sandboxed and uses a strict
 *    referrer policy so the slug-bearing invite path is never leaked to Google.
 *
 *  - **Drawn card (fallback)** — when no key is configured, OR the guest has
 *    not switched on Google Maps, a compact CSS-drawn card (a glow, a street
 *    grid and a pin) coloured from the invite's own palette tokens. It ships no
 *    image, needs no secret and makes no network request, so shipping the key
 *    is a pure enhancement. It is decoration (`aria-hidden`), not a link.
 *
 * CONSENT: the iframe loads `www.google.com/maps/embed`, which hands Google the
 * guest's IP and user-agent, so it sits behind the site-wide `maps` category
 * (see `lib/consent/`). The un-consented fallback is the drawn card rather than
 * the generic "content blocked" placeholder, deliberately: the address and the
 * link above and below it are the useful things, and following a link is the
 * guest's own navigation, which needs no consent. A guest who refuses loses the
 * interactive tiles and nothing else; the standing "Privacy choices" control in
 * the site footer is the route back.
 *
 * **One link, named by its words.** In both forms the only link is "Open in
 * maps", which follows `resolveMapsUrl` — the organiser's own `mapsUrl` (a
 * pinned entrance or car park) where they set one, which is not the place
 * Google's in-frame control opens. Its accessible name is its visible text,
 * and the venue it opens is the line directly above it.
 *
 * The whole row renders nothing when there is no usable maps target (no
 * `mapsUrl` and no address); with a `mapsUrl` alone it is the link alone,
 * since there is no address to print or to map.
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
        <div class="flex flex-col items-start gap-3">
          <Show when={venue()}>
            {(line) => (
              <>
                {/* The address wraps rather than being cut off: an ellipsis in
                    place of the suburb tells a guest nothing. `wrap-anywhere`
                    gives a single unbreakable token somewhere to break, so no
                    address can push the row wider than the sheet; the
                    three-line cap bounds one of unlimited length, since nothing
                    between the organiser's input and here constrains it. A full
                    address down to its country takes all three at 320px and
                    at 390px. */}
                <p
                  data-venue-address
                  class="font-body text-text text-ui-md line-clamp-3 w-full font-light wrap-anywhere"
                >
                  {line()}
                </p>
                <Show when={embedSrc()} fallback={<MapCard />}>
                  {(src) => (
                    <ConsentGate category="maps" vendor="google-maps" fallback={<MapCard />}>
                      <MapEmbed venue={line()} src={src()} />
                    </ConsentGate>
                  )}
                </Show>
              </>
            )}
          </Show>
          <a
            href={href()}
            target="_blank"
            rel="noopener noreferrer"
            class={`${buttonClass({ variant: "link", size: "md" })} min-h-11`}
          >
            Open in maps
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      )}
    </Show>
  );
}

/** The real Google Maps Embed iframe. It captures pointer events, so the link beside it carries the destination. */
function MapEmbed(props: { venue: string; src: string }) {
  return (
    <div class="border-border bg-bg w-full overflow-hidden rounded-md border">
      <iframe
        src={props.src}
        title={`Map of ${props.venue}`}
        loading="lazy"
        // Strict-origin matches the page-level referrer policy (`index.astro`
        // sets `strict-origin-when-cross-origin` to keep the slug-/`?code=`-
        // bearing path out of cross-origin Referer headers). Google's referrer
        // key-restriction only needs the origin, which this still sends.
        referrerpolicy="strict-origin-when-cross-origin"
        // Least-privilege sandbox. The Maps Embed needs scripts + same-origin
        // (to google.com) + popups (the "View larger map" link); withholding
        // allow-top-navigation/allow-forms removes the frame's ability to
        // navigate the guest page or submit forms.
        sandbox="allow-scripts allow-same-origin allow-popups"
        // A fixed box, so the iframe reserves its space up front and never
        // shifts layout as the embed loads.
        class="block h-36 w-full border-0"
      />
    </div>
  );
}

/**
 * The drawn card: a gold glow, a faint street grid and a pin, on the page's
 * own ground colour. Every colour is a palette token, so the card follows the
 * organiser's scheme rather than painting evergreen on every invite.
 */
function MapCard() {
  return (
    <div
      data-map-card
      aria-hidden="true"
      class="border-border relative h-24 w-full overflow-hidden rounded-md border"
      style={{
        "background-color": "var(--color-bg)",
        "background-image": [
          // the glow around the pin
          "radial-gradient(circle at 50% 58%, color-mix(in oklab, var(--color-gold) 18%, transparent) 0%, transparent 42%)",
          // diagonal "roads"
          "repeating-linear-gradient(38deg, color-mix(in oklab, var(--color-text) 8%, transparent) 0 1px, transparent 1px 26px)",
          "repeating-linear-gradient(-52deg, color-mix(in oklab, var(--color-text) 8%, transparent) 0 1px, transparent 1px 34px)",
          // faint base grid
          "repeating-linear-gradient(0deg, color-mix(in oklab, var(--color-text) 4%, transparent) 0 1px, transparent 1px 22px)",
          "repeating-linear-gradient(90deg, color-mix(in oklab, var(--color-text) 4%, transparent) 0 1px, transparent 1px 22px)",
        ].join(", "),
      }}
    >
      {/* Marker pin, centred over the glow. */}
      <div class="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-3/5 flex-col items-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="text-gold drop-shadow-pin"
        >
          <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
          <circle cx="12" cy="10" r="2.4" />
        </svg>
        {/* pin shadow ellipse on the "ground" */}
        <span class="bg-gold/30 blur-ground-shadow mt-0.5 h-1 w-3 rounded-full" />
      </div>
    </div>
  );
}
