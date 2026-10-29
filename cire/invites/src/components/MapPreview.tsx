import { buttonClass } from "@cire/ui/button";
import { createMemo, Show } from "solid-js";

import { ConsentGate } from "./consent/ConsentGate";
import {
  addressRepeatsName,
  resolveMapsEmbedUrl,
  resolveMapsUrl,
  venueLine,
  venueName,
} from "./event-details";
import { LinkMenu } from "./LinkMenu";
import { mapsDestinations } from "./maps-destinations";
import type { EventSummary } from "./types";

interface MapPreviewProps {
  event: EventSummary;
}

/**
 * The venue row of the event details: the venue's name and address, a map,
 * and "Open in maps".
 *
 * The map is one of two things:
 *
 *  - **Real map** — when `PUBLIC_GOOGLE_MAPS_EMBED_KEY` is configured at build
 *    time AND the event has an address or a venue name AND the guest has
 *    switched on Google Maps: a Google Maps Embed API `place` iframe keyed on
 *    the free-text address, else the name (no lat/lng, no geocoding). The key is
 *    referrer-restricted at the Maps Platform console, which is what makes
 *    baking it into static HTML safe. The iframe is sandboxed and sends only
 *    the page's origin as its referrer, so the slug-bearing invite path never
 *    reaches Google.
 *
 *  - **Drawn card (fallback)** — when no key is configured, when there is
 *    nothing to query, OR when the guest has not switched on Google Maps: a
 *    small card drawn in CSS from the invite's own palette — a wash of the gold
 *    round a pin and faint roads in the ink, on the page colour — so it belongs
 *    to every scheme. It ships no image, needs no secret, makes no request, and
 *    is decoration: hidden from assistive technology, and not a link.
 *
 * The iframe hands Google the guest's IP address and browser, so it sits behind
 * the `maps` consent switch (see `lib/consent/`), off until the guest allows it.
 * The un-consented fallback is the drawn card rather than the generic "content
 * switched off" placeholder, deliberately: the address above it names the venue
 * and "Open in maps" below it opens the guest's own maps app — a navigation the
 * guest makes, which needs no consent — so a guest who has not allowed Google
 * Maps loses the interactive tiles and nothing else. The route to the tiles is
 * the standing "Privacy choices" control at the foot of the invite, not a
 * permission prompt sitting in the layout of every venue on it.
 *
 * "Open in maps" is the row's one control in both cases, and it offers the
 * guest's own map app rather than Google's alone ({@link mapsDestinations}):
 * Google Maps, Apple Maps and Waze, each searching for the address, with the
 * organiser's own `mapsUrl` — a pinned entrance or car park — in place of the
 * app it belongs to, or first as "Venue map" when it is another site's. With
 * more than one, it is a {@link LinkMenu}; with one (an organiser's link and
 * nothing to search for) it is a plain link out, marked ↗. Google's in-frame
 * control opens a place query for the address, which is why the row keeps its
 * own beside the embed. Its words are its name; nothing overrides them, so a
 * guest using voice control can say what they see.
 *
 * The whole component renders nothing when there is no usable maps target at
 * all (no http(s) `mapsUrl`, no address and no venue name) — `hasVenue` makes
 * the same test through `resolveMapsUrl`, which has somewhere to go exactly
 * when `mapsDestinations` does, so the details panel leaves the row out rather
 * than show an empty one.
 *
 * Security: the map query (address, else name) is the only interpolated value
 * and is always `encodeURIComponent`-escaped (in `resolveMapsEmbedUrl`);
 * organiser text never reaches the iframe URL or the DOM unescaped, and the key
 * is never logged.
 */
export function MapPreview(props: MapPreviewProps) {
  // An address that already starts with the name says it all, so it is the
  // headline alone, as it is when there is no name.
  const name = () => (addressRepeatsName(props.event) ? null : venueName(props.event));
  const venue = () => venueLine(props.event);
  const mapsHref = () => resolveMapsUrl(props.event);
  const destinations = createMemo(() => mapsDestinations(props.event));
  // Vite statically replaces `import.meta.env.PUBLIC_*` at build time for the
  // island bundle, so the key bakes in (or is absent) just like the API URL.
  const embedSrc = () =>
    resolveMapsEmbedUrl(props.event, import.meta.env.PUBLIC_GOOGLE_MAPS_EMBED_KEY);

  return (
    <Show when={mapsHref()}>
      {(href) => (
        <>
          {/* With a name, the row reads as the When row above it does: the
              headline line (the name, as the day is there), then the detail
              under it in muted ink (the address, as the time is). Without one,
              the address is the headline. */}
          <Show when={name()}>
            {(line) => (
              <p class="font-body text-text text-ui-md line-clamp-2 font-light wrap-anywhere">
                {line()}
              </p>
            )}
          </Show>
          <Show when={venue()}>
            {(line) => (
              // The address wraps rather than being cut off: it is the one
              // thing this row exists to say, and an ellipsis in place of the
              // suburb tells a guest nothing. `wrap-anywhere` gives a single
              // unbreakable token somewhere to break, so no address can push
              // the row wider than the sheet; the four-line cap bounds one of
              // unlimited length, since nothing between the organiser's input
              // and here constrains it. A full address down to its country
              // takes three lines in the narrowest column this row renders in.
              // The name above takes two lines at most, for the same reason.
              <p
                class="font-body text-ui-base line-clamp-4 wrap-anywhere"
                classList={{
                  "text-text font-light": !name(),
                  "text-text-muted mt-0.5": Boolean(name()),
                }}
              >
                {line()}
              </p>
            )}
          </Show>
          <Show when={embedSrc()} fallback={<MapCard />}>
            {(src) => (
              <ConsentGate category="maps" vendor="google-maps" fallback={<MapCard />}>
                <MapEmbed venue={name() ?? venue()} src={src()} />
              </ConsentGate>
            )}
          </Show>
          <Show
            when={destinations().length > 1}
            fallback={
              <a
                href={href()}
                target="_blank"
                rel="noopener noreferrer"
                class={`${buttonClass({ variant: "touchLink", size: "md" })} mt-1 min-h-11`}
              >
                Open in maps
                <span aria-hidden="true">↗</span>
              </a>
            }
          >
            <LinkMenu
              label="Open in maps"
              menuLabel="Open in maps options"
              items={destinations()}
              class="mt-1"
            />
          </Show>
        </>
      )}
    </Show>
  );
}

/** The real Google Maps Embed iframe. */
function MapEmbed(props: { venue: string | null; src: string }) {
  const title = () => `Map of ${props.venue ?? "the venue"}`;

  return (
    <div class="border-border bg-bg rounded-ui-field mt-3 overflow-hidden border">
      <iframe
        src={props.src}
        title={title()}
        loading="lazy"
        // Strict-origin matches the page-level referrer policy
        // (`index.astro` sets `strict-origin-when-cross-origin` to keep the
        // slug-/`?code=`-bearing path out of cross-origin Referer headers).
        // Google's referrer key-restriction only needs the origin, which this
        // still sends, so the embed and the key restriction keep working.
        referrerpolicy="strict-origin-when-cross-origin"
        // A least-privilege sandbox. The Maps Embed needs scripts +
        // same-origin (to google.com) + popups (the "View larger map" link);
        // withholding allow-top-navigation/allow-forms removes the frame's
        // ability to navigate the guest page or submit forms.
        sandbox="allow-scripts allow-same-origin allow-popups"
        // A fully constrained box (h-36 = 9rem tall, full-width), so the
        // iframe reserves its space up front and never shifts layout as the
        // embed loads.
        class="block h-36 w-full border-0"
      />
    </div>
  );
}

/**
 * The drawn card: a pin over a wash of the scheme's gold, faint roads in its
 * ink, on its page colour. Every colour is a token, mixed with transparency, so
 * the card is the invite's own on every palette rather than one scheme's.
 */
function MapCard() {
  return (
    <div
      aria-hidden="true"
      class="border-border rounded-ui-field relative mt-3 h-24 w-full overflow-hidden border"
      style={{
        "background-color": "var(--color-bg)",
        "background-image": [
          // the wash round the pin
          "radial-gradient(circle at 50% 55%, color-mix(in oklab, var(--color-gold) 18%, transparent) 0%, transparent 45%)",
          // diagonal "roads"
          "repeating-linear-gradient(38deg, color-mix(in oklab, var(--color-text) 8%, transparent) 0 1px, transparent 1px 26px)",
          "repeating-linear-gradient(-52deg, color-mix(in oklab, var(--color-text) 8%, transparent) 0 1px, transparent 1px 34px)",
        ].join(", "),
      }}
    >
      <div class="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-3/5 flex-col items-center">
        <svg
          width="22"
          height="22"
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
        {/* the pin's shadow on the "ground" */}
        <span class="bg-gold/30 blur-ground-shadow mt-0.5 h-1 w-3 rounded-full" />
      </div>
    </div>
  );
}
