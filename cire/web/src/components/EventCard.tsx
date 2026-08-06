import { batch, createEffect, createSignal, onCleanup, on, Show } from "solid-js";

import { cropAspectRatio, cropBackgroundStyle } from "./image-crop";
import { buildSrcSet, variantSrc } from "./invite-images";

// The event card photo's default display aspect (4∶3) — used when a crop carries
// no source dimensions (a legacy crop), so the box keeps today's fixed shape.
const EVENT_DEFAULT_ASPECT = 4 / 3;
import { formatEventDay, venueLine } from "./event-details";
import { HOLD_MS, TOTAL_DURATION_MS } from "./rsvp-responded";
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
  /**
   * The wedding's RSVP deadline has passed. "Respond" becomes an inert, plainly
   * labelled "RSVPs closed" rather than disappearing — a missing button reads
   * as a broken invite, and the events-section notice above says when it shut.
   * Event details stay open; only the answer is locked.
   *
   * Marked `aria-disabled`, NOT `disabled` (C-M2): the native attribute takes
   * the button out of the tab order, so the one per-card statement of why the
   * action is gone becomes unreachable to a keyboard or screen-reader user —
   * and because the deadline can pass on a live timer, a guest focused on
   * Respond at that instant would lose focus to `<body>` mid-session.
   * `aria-disabled` conveys the same "cannot activate" semantics while keeping
   * the control focusable; the click handler enforces it.
   */
  rsvpClosed?: boolean;
  /**
   * Id of the events-section deadline notice, pointed at by `aria-describedby`
   * once closed, so the button announces WHEN RSVPs shut and not just that they
   * did. Optional — the button is still self-describing without it.
   */
  rsvpClosedNoticeId?: string;
  /**
   * True once this household's RSVP for this event is on file — driven by
   * data (`hasHouseholdResponded` in `rsvp-responded.ts`), not by anything
   * that happened this session. Renders a permanent green tick on Respond, no
   * animation: a guest who reopens the invite tomorrow should see the same
   * mark a guest who just submitted settles into, without watching it draw.
   */
  responded?: boolean;
  /**
   * Pulses true for exactly one render the instant THIS event's reply is
   * confirmed (see `RsvpModal`'s `onConfirmed`) — the transition from false
   * to true is what plays the sweep-in/hold/fade-out choreography documented
   * in `rsvp-responded.ts`. An event that starts `true` on mount (it cannot,
   * in practice — the parent only ever flips this from a live confirmation —
   * but the guard exists regardless) plays no animation, matching `responded`
   * above: only a fresh transition celebrates.
   */
  justResponded?: boolean;
  /**
   * Fired once the celebration has fully played out (fill faded back, tick
   * settled), so the parent can reset `justResponded` back to false and be
   * ready to celebrate the NEXT confirmation for this event (an edited,
   * re-submitted reply) rather than only ever the first one.
   */
  onCelebrated?: () => void;
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

  // The Respond-button confirmation (see `rsvp-responded.ts`). `celebrating`
  // spans the whole choreography (sweep-in through fade-out) and gates
  // whether the tick renders at all when `responded` is false, such as during
  // the host preview's ephemeral flourish (see `RsvpModal`'s `onConfirmed`) —
  // preview never sets `responded`, since nothing was actually written.
  // `filled` is the sub-state that actually drives the green fill: true
  // through the sweep-in and the hold, false once the fade-out starts, so it
  // can double as the tick's ink switch (on-fill while filled, permanent
  // `text-success` once it isn't).
  const [celebrating, setCelebrating] = createSignal(false);
  const [filled, setFilled] = createSignal(false);

  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    if (endTimer !== undefined) clearTimeout(endTimer);
  });

  function playCelebration() {
    // A re-submit (edited reply) while a previous celebration is still
    // fading out restarts the choreography from the top rather than layering
    // a second pair of timers over the first.
    if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    if (endTimer !== undefined) clearTimeout(endTimer);
    batch(() => {
      setCelebrating(true);
      setFilled(true);
    });
    fadeTimer = setTimeout(() => {
      fadeTimer = undefined;
      setFilled(false);
    }, HOLD_MS);
    endTimer = setTimeout(() => {
      endTimer = undefined;
      setCelebrating(false);
      props.onCelebrated?.();
    }, TOTAL_DURATION_MS);
  }

  // Only a real false→true transition celebrates. `on`'s `prev` is
  // `undefined` on the effect's first run, so a card that somehow mounts with
  // `justResponded` already true (the parent never does this in practice)
  // plays no animation — same rule `responded` follows on its own.
  createEffect(
    on(
      () => props.justResponded,
      (justResponded, previously) => {
        if (justResponded && previously !== undefined && !previously) playCelebration();
      },
    ),
  );

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
              these per card was the page's largest source of eyebrow noise.
              `text-gold-ink`, not `text-gold`: at 0.92rem this is normal-size
              text (4.5:1), while the metal token is only held to the 3:1 UI
              floor — which shipped this line at 3.58:1 on `chapel` and 3.91:1
              on `garden` (C-M2). */}
          <p class="font-body text-gold-ink mb-1 text-[0.92rem]">{formatEventDay(props.event)}</p>
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
            {/* Closed, this drops to the SECONDARY outlined treatment rather
                than dimming the filled button with an opacity: without the
                native `disabled` attribute there is no WCAG 1.4.3
                inactive-component exemption to lean on, and the outlined pair
                beside it is a contrast combination this card already ships. */}
            <button
              class="font-body relative min-h-11 flex-1 overflow-hidden rounded-sm border px-5 py-3 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200 sm:flex-none sm:py-2.5"
              classList={{
                "bg-gold text-bg hover:bg-gold/85 border-transparent": !props.rsvpClosed,
                "border-border text-text-muted cursor-not-allowed bg-transparent": props.rsvpClosed,
              }}
              onClick={() => {
                // `aria-disabled` is advisory to AT — this guard is what makes
                // it real for pointer and keyboard alike.
                if (props.rsvpClosed) return;
                props.onRespond(props.event);
              }}
              aria-disabled={props.rsvpClosed ? "true" : undefined}
              aria-describedby={props.rsvpClosed ? props.rsvpClosedNoticeId : undefined}
            >
              {/* The confirmation fill. Mounted at `scale-x-0` from the start
                  and never conditionally rendered, because a CSS transition
                  needs a starting frame to travel from — an element created
                  already in its end state simply appears there. Invisible
                  outside a celebration since `filled` only ever turns true
                  from `playCelebration`. */}
              <span
                aria-hidden="true"
                class="bg-success absolute inset-0 origin-left scale-x-0 transition-transform duration-500 ease-out"
                classList={{ "scale-x-100": filled() }}
              />
              <span class="relative flex items-center justify-center gap-2">
                {/* Conditional, not merely invisible: a tick mounted for an
                    event nobody has answered would claim a reply that was
                    never sent. Shown for a genuinely recorded reply
                    (`responded`) OR the mid-celebration flourish (which also
                    covers host preview — see `RsvpModal`'s `onConfirmed`). */}
                <Show when={props.responded || celebrating()}>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    class="h-4 w-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    classList={{
                      // On-fill ink while the green sweep is up, matching the
                      // label; the permanent green signifier only once it's
                      // gone (settled, or was already gone — a page load with
                      // an existing reply never plays the fill at all).
                      "text-bg": filled(),
                      "text-success": !filled(),
                    }}
                  >
                    <Show when={celebrating()} fallback={<path d="M5 13l4 4L19 7" />}>
                      {/* `stroke-dasharray` of 20 slightly over-covers the
                          ~19.8 path so it starts fully hidden; the keyframe
                          walks the offset back to 0 to draw it. Only during a
                          live celebration — the settled/preloaded tick above
                          is simply drawn, not animated into being. */}
                      <path d="M5 13l4 4L19 7" stroke-dasharray="20" class="animate-tick-draw" />
                    </Show>
                  </svg>
                </Show>
                {props.rsvpClosed ? "RSVPs closed" : "Respond"}
              </span>
            </button>
            <button
              class="border-border font-body text-text-muted hover:border-gold hover:text-gold-ink min-h-11 flex-1 rounded-sm border bg-transparent px-5 py-3 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200 sm:flex-none sm:py-2.5"
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
