import { Show } from "solid-js";

import { resolveMapsUrl, venueLine } from "./event-details";
import type { EventSummary } from "./types";

interface MapPreviewProps {
  event: EventSummary;
}

/**
 * A branded, self-contained map-style preview for a wedding event.
 *
 * Cire stores only a venue `address` + an optional `mapsUrl` — no lat/lng
 * coordinates — and assumes NO map API key. So rather than a real (keyed,
 * networked) tile that would break the page when the key or coordinates are
 * absent, this renders a CSS-drawn "cartographic" card in the invite palette:
 * stylised gold contour rings and a street grid behind a marker pin, with the
 * address overlaid. It reads as a map without pretending to be satellite
 * imagery, needs zero secrets, and never makes a network request.
 *
 * The whole card is an outbound link to maps: it uses the organiser's `mapsUrl`
 * when present, otherwise derives a Google Maps search URL from the address
 * (see `resolveMapsUrl`). If there is nothing to point at, the component renders
 * nothing — no dead button, no broken tile.
 */
export function MapPreview(props: MapPreviewProps) {
  const venue = () => venueLine(props.event);
  const mapsHref = () => resolveMapsUrl(props.event);

  return (
    <Show when={mapsHref()}>
      {(href) => (
        <a
          href={href()}
          target="_blank"
          rel="noopener noreferrer"
          class="group border-border bg-bg focus-visible:ring-gold/60 relative block overflow-hidden rounded-md border focus:outline-none focus-visible:ring-2"
          aria-label={`Open ${venue() ?? "the venue"} in maps`}
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

          {/* Address + action row. */}
          <div class="border-border/70 bg-surface-raised flex items-center justify-between gap-3 border-t px-4 py-3">
            <Show
              when={venue()}
              fallback={
                <span class="font-body text-text-muted text-[0.8rem] italic">View on map</span>
              }
            >
              {(line) => (
                <span class="font-body text-text-muted min-w-0 flex-1 truncate text-left text-[0.82rem]">
                  {line()}
                </span>
              )}
            </Show>
            <span class="border-gold font-body text-gold group-hover:bg-gold group-hover:text-bg inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-3.5 py-1.5 text-[0.72rem] tracking-[0.12em] uppercase transition-colors duration-200">
              Open in Maps
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
            </span>
          </div>
        </a>
      )}
    </Show>
  );
}
