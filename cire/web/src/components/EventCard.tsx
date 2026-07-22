import { Show } from "solid-js";

import { cropAspectRatio, cropBackgroundStyle } from "./image-crop";
import { buildSrcSet, variantSrc } from "./InviteHeader";

// The event card photo's default display aspect (4∶3) — used when a crop carries
// no source dimensions (a legacy crop), so the box keeps today's fixed shape.
const EVENT_DEFAULT_ASPECT = 4 / 3;
import { formatEventDay, venueLine } from "./event-details";
import type { EventSummary } from "./types";

interface EventCardProps {
  event: EventSummary;
  /**
   * The API origin, prepended to the event's relative `imageUrl` path. Absent ⇒
   * the image is treated as unavailable (text-only card) — keeps no-origin
   * callers (unit tests) deterministic.
   */
  apiUrl?: string;
  /**
   * Alternating row rhythm on desktop. `norm` = text LEFT / image RIGHT; `alt` =
   * image LEFT / text RIGHT. Driven by the event's index in InvitePage
   * (even ⇒ norm, odd ⇒ alt). Ignored when the event has no image (single
   * text-only column at every breakpoint).
   */
  orientation?: "norm" | "alt";
  onRespond: (event: EventSummary) => void;
  onDetails: (event: EventSummary) => void;
}

export function EventCard(props: EventCardProps) {
  // Resolve the absolute image URL once. Null (no image, or no API origin) ⇒ the
  // card collapses to a single text-only column with no empty image half.
  const imageUrl = (): string | null => {
    const path = props.event.imageUrl;
    if (!path || !props.apiUrl) return null;
    return `${props.apiUrl}${path}`;
  };
  const isAlt = () => props.orientation === "alt";

  return (
    <article class="border-border bg-surface-raised rounded-sm border px-6 py-7">
      {/*
        Two-column on laptop/desktop ONLY when this event has an image — mirrors
        the "Our Story" split in InviteHeader. The image wrapper is `hidden`
        below md? No — for EVENTS the image IS shown on mobile (stacked BELOW the
        text). So: one column on mobile (text then image), two columns on md+
        (vertically centred, comfortable gap). With no image the grid is a single
        cell, so the text spans the full width at every breakpoint (no empty
        half). DOM order is always text-first (accessible); on `alt` rows the
        image is moved to the LEFT on md+ via `order` without changing DOM order.
      */}
      <div
        class="grid items-center gap-6 data-[has-image=true]:md:grid-cols-2 data-[has-image=true]:md:gap-10"
        data-has-image={imageUrl() ? "true" : "false"}
        data-orientation={props.orientation ?? "norm"}
      >
        {/* Text column — always first in the DOM. On `alt` rows it sits on the
            RIGHT on md+ (order-2); on `norm` rows it stays left (order-1). */}
        <div classList={{ "md:order-2": isAlt(), "md:order-1": !isAlt() }}>
          <h3 class="font-display text-text mb-2 text-2xl font-normal">{props.event.name}</h3>
          {/* A date, set as a date — not as an uppercase micro-label. One of
              these per card was the page's largest source of eyebrow noise. */}
          <p class="font-body text-gold mb-1 text-[0.92rem]">{formatEventDay(props.event)}</p>
          <Show when={venueLine(props.event)}>
            {(venue) => <p class="font-body text-text-muted mb-3 text-[0.88rem]">{venue()}</p>}
          </Show>
          <p class="font-body text-text-muted mb-5 text-[0.88rem] leading-[1.65] font-light">
            {props.event.description}
          </p>
          {/* One act matters on this page: answering. So "Respond" is the only
              filled button, and "Event Details" stays an outlined one beside it
              — a real button, but visibly second. Two equal outlines made the
              guest choose between them; now the choice is made for them. */}
          <div class="flex flex-wrap gap-3">
            <button
              class="bg-gold font-body text-bg hover:bg-gold/85 min-h-11 flex-1 rounded-sm border border-transparent px-5 py-3 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200 sm:flex-none sm:py-2.5"
              onClick={() => props.onRespond(props.event)}
            >
              Respond
            </button>
            <button
              class="border-border font-body text-text-muted hover:border-gold hover:text-gold min-h-11 flex-1 rounded-sm border bg-transparent px-5 py-3 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200 sm:flex-none sm:py-2.5"
              onClick={() => props.onDetails(props.event)}
            >
              Event Details
            </button>
          </div>
        </div>

        {/* Image column — second in the DOM (after the text), shown on mobile
            stacked below the text and on md+ beside it. On `alt` rows it moves to
            the LEFT on md+ (order-1); on `norm` rows it stays right (order-2). */}
        <Show when={imageUrl()}>
          {(url) => {
            // Cropped region (organiser pan/zoom) via the shared CSS fraction
            // technique — a `card`-variant background (backgrounds can't use
            // srcset; card comfortably covers the ~480px column at retina). With
            // no crop, keep the responsive <img srcset> + object-cover (unchanged).
            const cropStyle = () =>
              cropBackgroundStyle(variantSrc(url(), "card"), props.event.imageCrop);
            return (
              <Show
                when={cropStyle()}
                fallback={
                  <img
                    src={url()}
                    // Event photo renders at most ~480px wide in a column — thumb/card
                    // cover it; the API negotiates WebP/AVIF per request via Accept.
                    srcset={buildSrcSet(url(), ["thumb", "card"])}
                    sizes="(min-width: 768px) 480px, 100vw"
                    alt={`${props.event.name} event`}
                    loading="lazy"
                    class="border-border max-h-[320px] w-full rounded-sm border object-cover"
                    classList={{ "md:order-1": isAlt(), "md:order-2": !isAlt() }}
                  />
                }
              >
                {(style) => (
                  <div
                    role="img"
                    aria-label={`${props.event.name} event`}
                    // The box adopts the crop's TRUE pixel aspect (from its captured
                    // source dims), so the uniformly-scaled region fills it with no
                    // distortion and no empty bars. A legacy crop (no dims) falls
                    // back to the card's default 4∶3 shape.
                    class="border-border max-h-[320px] w-full overflow-hidden rounded-sm border"
                    classList={{ "md:order-1": isAlt(), "md:order-2": !isAlt() }}
                    style={{
                      ...style(),
                      "aspect-ratio": String(
                        cropAspectRatio(props.event.imageCrop, EVENT_DEFAULT_ASPECT),
                      ),
                    }}
                  />
                )}
              </Show>
            );
          }}
        </Show>
      </div>
    </article>
  );
}
