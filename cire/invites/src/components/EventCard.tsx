import { batch, createEffect, createSignal, onCleanup, on, Show } from "solid-js";

import { cropAspectRatio, cropBackgroundStyle } from "./image-crop";
import { buildSrcSet, variantSrc } from "./invite-images";

// The event card photo's default display aspect (4∶3) — used when a crop carries
// no source dimensions (a legacy crop), so the box keeps today's fixed shape.
const EVENT_DEFAULT_ASPECT = 4 / 3;
import { formatEventDay, venueLine } from "./event-details";
import { TOTAL_DURATION_MS } from "./rsvp-responded";
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
   * that happened this session. Renders Respond permanently filled with
   * `bloom` and ticked, no animation: a guest who reopens the invite
   * tomorrow should see the same mark a guest who just submitted settles
   * into, without watching either draw.
   */
  responded?: boolean;
  /**
   * True while THIS event's RSVP sheet is open over this card.
   *
   * The one thing standing between `responded` and the fill. The real submit
   * path records the reply — flipping `responded` — a full `SAVED_DWELL_MS`
   * before the sheet closes, so a fill that tracked `responded` alone would
   * sweep in behind the sheet and be over by the time the guest could see the
   * button. Holding the sync until the sheet is gone is what keeps the sweep
   * watchable, and it covers the guest who dismisses the sheet early (Escape,
   * backdrop) just as well as the one who watches the confirmation play.
   *
   * Optional: a caller that never opens a sheet (unit tests, the closed-RSVP
   * card) simply never covers the button.
   */
  covered?: boolean;
  /**
   * Pulses true for exactly one render the instant THIS event's reply is
   * confirmed (see `RsvpModal`'s `onConfirmed`) — the transition from false
   * to true is what plays the sweep-in and the tick draw documented in
   * `rsvp-responded.ts`. An event that starts `true` on mount (it cannot, in
   * practice — the parent only ever flips this from a live confirmation —
   * but the guard exists regardless) plays no animation, matching `responded`
   * above: only a fresh transition celebrates.
   *
   * This is a cue to ANIMATE, never the source of the mark itself. A save that
   * lands without one (an early-dismissed sheet) still ends up marked, via
   * `responded`; a preview that will never have a `responded` still ends up
   * marked, via this. Neither can end up unmarked.
   */
  justResponded?: boolean;
  /**
   * Fired once the tick has finished drawing, so the parent can reset
   * `justResponded` back to false and be ready to animate the NEXT
   * confirmation for this event (an edited, re-submitted reply) rather than
   * only ever the first one. The fill and tick are already in their permanent
   * state by then and this does not disturb them.
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

  // The Respond-button confirmation (see `rsvp-responded.ts`), as exactly two
  // pieces of state.
  //
  // `confirmed` is the mark itself — the bloom fill AND the tick, which are
  // always shown together. It is MONOTONE: once true it never returns to false
  // for the life of the card. That is the whole fix for the bug this shipped
  // with twice. Nothing — not a timer ending, not `responded` arriving late,
  // not a preview that never wrote a row — can take the fill back off, because
  // there is no code path that sets it false.
  //
  // `drawing` is the tick's stroke animation and nothing else. Earlier versions
  // used the equivalent signal to gate whether the tick RENDERED, which is why
  // the tick vanished 900ms in on every path where `responded` stayed false
  // (host preview, most visibly). A cosmetic, self-cancelling animation must
  // never decide whether a permanent mark exists.
  //
  // Seeded from `responded` at mount so a reload of an answered event paints the
  // settled state on its first frame rather than animating into it — but gated on
  // `covered` by the same rule the effect below follows, so "the mark never goes
  // up while the sheet is over the button" holds without a mount-time exception.
  const [confirmed, setConfirmed] = createSignal((props.responded ?? false) && !props.covered);
  const [drawing, setDrawing] = createSignal(false);

  // A reply on file always ends up marked — but never while the sheet is still
  // over the button (see `covered`). Seeding `confirmed` from `responded` at
  // mount handles the reload; this handles every later arrival, including the
  // guest who dismissed the sheet early and so never got a celebration cue.
  createEffect(() => {
    if (props.responded && !props.covered) setConfirmed(true);
  });

  let endTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (endTimer !== undefined) clearTimeout(endTimer);
  });

  function playCelebration() {
    // A re-submit (edited reply) while a previous celebration is still
    // holding restarts the tick draw from the top rather than layering a
    // second timer over the first. The fill does not replay — it is already
    // up, and flickering it back to zero to re-sweep would read as the reply
    // being withdrawn.
    if (endTimer !== undefined) clearTimeout(endTimer);
    batch(() => {
      // Not redundant with the effect above: host preview reaches here with
      // `responded` false forever, and its flourish must settle rather than
      // blink out.
      setConfirmed(true);
      setDrawing(true);
    });
    endTimer = setTimeout(() => {
      endTimer = undefined;
      setDrawing(false);
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
              // The confirmation state, readable from the DOM. Tailwind classes
              // are an implementation detail of the fill; this is the fact.
              data-rsvp-confirmed={confirmed() ? "true" : undefined}
            >
              {/* The confirmation fill. Always mounted, never conditionally
                  rendered, because a CSS transition needs a painted starting
                  frame to travel from — an element created already in its end
                  state simply appears there. (A card that mounts already
                  `confirmed`, i.e. a reload of an answered event, therefore
                  starts filled with no animation, which is what a returning
                  guest should see.) `bloom` is the accent for this: the guest
                  site's other chromatic accent, `gold`, is already the
                  button's base colour, so it can't also mark the "after"
                  state.

                  BOTH scale utilities come from `classList`, so exactly one is
                  ever present. Carrying `scale-x-0` as a static class and
                  layering `scale-x-100` on top used to work only because
                  Tailwind happened to emit them in that order — two
                  conflicting utilities on one element resolve by STYLESHEET
                  order, not class-attribute order, so that arrangement was one
                  Tailwind version bump away from a fill that never appeared,
                  with every class-presence test still green.
                  `EventCard.browser.test.tsx` measures the real thing. */}
              <span
                aria-hidden="true"
                class="bg-bloom absolute inset-0 origin-left transition-transform duration-500 ease-out"
                classList={{ "scale-x-100": confirmed(), "scale-x-0": !confirmed() }}
              />
              <span class="relative flex items-center justify-center gap-2">
                {props.rsvpClosed ? "RSVPs closed" : "Respond"}
                {/* Conditional, not merely invisible: a tick mounted for an
                    event nobody has answered would claim a reply that was
                    never sent. Gated on the SAME state as the fill, so the two
                    can never disagree — the tick always sits on bloom, which
                    is why `text-bg` is the only ink it needs. */}
                <Show when={confirmed()}>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    class="text-bg h-4 w-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <Show when={drawing()} fallback={<path d="M5 13l4 4L19 7" />}>
                      {/* `stroke-dasharray` of 20 slightly over-covers the
                          ~19.8 path so it starts fully hidden; the keyframe
                          walks the offset back to 0 to draw it. Only during a
                          live celebration — a settled or preloaded tick is
                          simply drawn, not animated into being. */}
                      <path d="M5 13l4 4L19 7" stroke-dasharray="20" class="animate-tick-draw" />
                    </Show>
                  </svg>
                </Show>
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
