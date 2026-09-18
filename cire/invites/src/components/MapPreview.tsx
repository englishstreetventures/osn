import { Show } from "solid-js";

import { ConsentGate } from "./consent/ConsentGate";
import { resolveMapsEmbedUrl, resolveMapsUrl, venueLine } from "./event-details";
import type { EventSummary } from "./types";

interface MapPreviewProps {
  event: EventSummary;
}

/**
 * Map preview for a wedding event's "Where" section.
 *
 * Two render paths share one footer (venue line + an "Open in Maps" icon):
 *
 *  - **Real map** — when `PUBLIC_GOOGLE_MAPS_EMBED_KEY` is configured at build
 *    time AND the event has a venue address AND the guest has allowed
 *    third-party content, the top of the card is a Google Maps Embed API
 *    `place` iframe keyed on the free-text address (no lat/lng, no geocoding,
 *    no schema change). The key is referrer-restricted at the Maps Platform
 *    console, which is what makes baking it into static HTML safe. The iframe
 *    is sandboxed and uses a strict referrer policy so the slug-bearing invite
 *    path is never leaked to Google (see S-L1 / S-L2).
 *
 *  - **CSS card (fallback)** — when no key is configured, when there is no
 *    address to query, OR when the guest has not allowed third-party content,
 *    the top is a self-contained CSS-drawn "cartographic" card (gold contour
 *    rings + street grid + marker pin) that ships no image, needs no secret,
 *    and makes no network request. This keeps the page working before any key
 *    exists, so shipping the key is a pure enhancement.
 *
 * CONSENT (added 2026-07-29): the iframe loads `www.google.com/maps/embed`,
 * which hands Google the guest's IP and user-agent — the same class of transfer
 * to the same class of US recipient that the Pinterest moodboard was already
 * gated for, but which shipped ungated here simply because this component was
 * written without one. It now sits behind the site-wide `embeds` category (see
 * `lib/consent/`).
 *
 * The un-consented fallback is the CSS card rather than the generic "content
 * blocked" placeholder, deliberately: the card is a genuinely useful thing to
 * put where a map goes — it names the venue and the card is itself a link to the
 * guest's own maps app, which is a plain outbound navigation the guest
 * initiates and so needs no consent. A guest who refuses loses the interactive
 * tiles and nothing else. The cost is that the card gives no hint that a richer
 * map is available; the standing "Privacy choices" control in the site footer
 * is the route back, rather than a permission prompt sitting in the layout of
 * every venue on the invite.
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
          {(src) => (
            <ConsentGate
              category="embeds"
              vendor="google-maps"
              fallback={<MapCard href={href()} venue={venue()} />}
            >
              <MapEmbed href={href()} venue={venue()} src={src()} />
            </ConsentGate>
          )}
        </Show>
      )}
    </Show>
  );
}

/**
 * The real Google Maps Embed iframe + the shared footer. The iframe captures
 * pointer events, so (unlike the CSS card) the actionable "open in maps" link
 * lives in the footer rather than wrapping the whole card.
 *
 * That link is not a duplicate of Google's own in-frame control. It follows
 * `resolveMapsUrl`, which prefers the organiser's `mapsUrl` — a pinned entrance
 * or car park — where Google's control opens a place query for the address.
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
        class="relative h-36 w-full motion-safe:transition-transform motion-safe:duration-500 motion-safe:group-hover:scale-103"
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
        <div class="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-3/5 flex-col items-center">
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-gold drop-shadow-pin"
            aria-hidden="true"
          >
            <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
            <circle cx="12" cy="10" r="2.4" />
          </svg>
          {/* pin shadow ellipse on the "ground" */}
          <span class="bg-gold/30 blur-ground-shadow mt-0.5 h-1 w-3 rounded-full" />
        </div>
      </div>

      <FooterRow href={props.href} venue={props.venue} interactive={false} />
    </a>
  );
}

/**
 * Shared footer: the venue line and the "Open in Maps" action.
 *
 * **The action is an icon, and the words are clipped rather than dropped.** A
 * `sr-only` span carries "Open in Maps" at every width, so the wording is still
 * there for a screen reader while the glyph stands in for it on screen. The
 * words cost the venue address 140px of a 236px row at phone widths, which is
 * more of the footer than the thing the footer exists to say.
 *
 * **It is a link on one path and a decoration on the other**, and the two must
 * not be flattened into each other. In the iframe path the map captures pointer
 * events, so this is the only element that can carry the destination — and the
 * destination is worth carrying, because it is the organiser's own `mapsUrl`
 * where they set one, which is not the place Google's in-frame control opens.
 * In the CSS-card path the enclosing `<a>` is already that link, so this is a
 * non-interactive `<span>`: the visible signal that the card is clickable, never
 * a second tab stop for one destination.
 */
function FooterRow(props: { href: string; venue: string | null; interactive?: boolean }) {
  const isLink = () => props.interactive !== false;

  return (
    <div class="border-border/70 bg-surface-raised flex items-center justify-between gap-3 border-t px-4 py-3">
      <Show
        when={props.venue}
        fallback={<span class="font-body text-text-muted text-ui-sm italic">View on map</span>}
      >
        {(line) => (
          // The address wraps rather than being cut off: it is the one thing
          // this footer exists to say, and an ellipsis in place of the suburb
          // tells a guest nothing. `wrap-anywhere` gives a single unbreakable
          // token somewhere to break, so no address can push the row wider than
          // the card; the three-line cap bounds one of unlimited length, since
          // nothing between the organiser's input and here constrains it. Three
          // is what the narrowest column this footer renders in fits, and a full
          // address with its country needs all of them there.
          <span class="font-body text-text-muted text-ui-sm line-clamp-3 min-w-0 flex-1 text-left wrap-anywhere">
            {line()}
          </span>
        )}
      </Show>
      <Show
        when={isLink()}
        fallback={
          <span class="border-gold text-gold-ink group-hover:bg-gold group-hover:text-bg inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border transition-colors duration-200">
            <OpenIcon />
            <span class="sr-only">Open in Maps</span>
          </span>
        }
      >
        <a
          href={props.href}
          target="_blank"
          rel="noopener noreferrer"
          // Names the venue, so it is more specific than the clipped label
          // inside and wins over it. The label is what names this action in the
          // card path, where the element carrying it is not a link.
          aria-label={`Open ${props.venue ?? "the venue"} in maps`}
          class="border-gold text-gold-ink hover:bg-gold hover:text-bg focus-visible:ring-gold/60 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border transition-colors duration-200 focus:outline-none focus-visible:ring-2"
        >
          <OpenIcon />
          <span class="sr-only">Open in Maps</span>
        </a>
      </Show>
    </div>
  );
}

function OpenIcon() {
  return (
    <svg
      width="16"
      height="16"
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
