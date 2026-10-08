import Button from "@cire/ui/button";
import { createEffect, createUniqueId, For, Show, type JSX } from "solid-js";

import { AddToCalendar } from "./AddToCalendar";
import { isValidColor, truncateSwatchName } from "./dress-code-render";
import { formatEventDay, formatTimeRange, timezoneLabel } from "./event-details";
import { hasDressCode, hasPinterest } from "./invite-emptiness";
import { MapPreview } from "./MapPreview";
import { PinterestBoard } from "./PinterestBoard";
import type { EventSummary } from "./types";

export interface DetailsPanelProps {
  event: EventSummary;
  /** Origin used to stamp the calendar invite's "Invite:" link. */
  siteUrl: string;
  /**
   * Moves the sheet to the event's RSVP form. Absent ⇒ no "RSVP for this
   * event" button (a panel rendered on its own).
   */
  onRsvp?: () => void;
  /**
   * The wedding's RSVP deadline has passed. The RSVP button gives way to a line
   * saying so, as the card's Respond becomes "RSVPs closed": the details stay
   * open, only the answer is locked.
   */
  rsvpClosed?: boolean;
  /** The deadline day in words, for that line ("RSVPs closed on …"). */
  rsvpClosedOn?: string;
  /**
   * Whether this panel is the one on screen. Default true. `EventSheet` keeps a
   * panel mounted, hidden, after the guest moves to the other one; a hidden
   * panel must not take focus for itself.
   */
  active?: boolean;
  /** `id` for the heading, which names the sheet while this panel shows. */
  titleId?: string;
  /** Receives the heading, which takes focus when the guest switches here. */
  headingRef?: (el: HTMLHeadingElement) => void;
}

/** A labelled section in the holistic event view, fronted by the gold eyebrow. */
function Section(props: { label: string; children: JSX.Element }) {
  return (
    <section class="border-border/80 border-t pt-6">
      <h4 class="font-body text-gold-ink text-ui-xs tracking-ui-ultra mb-3 font-normal uppercase">
        {props.label}
      </h4>
      {props.children}
    </section>
  );
}

/**
 * The holistic "everything about this event" view, one of `EventSheet`'s two
 * panels. It gathers when the event runs (timezone-aware), a branded map
 * preview naming the venue with an Open-in-Maps action, an Add-to-Calendar
 * control, the description, the dress code with its colour palette, and the
 * Pinterest inspiration board — and offers the RSVP form beside them.
 *
 * Every section renders only when it has content, so a sparse event collapses
 * gracefully to just its header and timing rather than showing empty shells.
 */
export function DetailsPanel(props: DetailsPanelProps) {
  const day = () => formatEventDay(props.event);
  const timeRange = () => formatTimeRange(props.event);
  const tz = () => timezoneLabel(props.event);
  const titleId = props.titleId ?? createUniqueId();
  const rsvpOffered = () => props.onRsvp !== undefined && props.rsvpClosed !== true;

  // The deadline can pass while this panel is open, and the RSVP button goes
  // with it. If focus was ON that button, the browser drops it to `<body>` —
  // outside a modal dialog, with no keyboard way back in — so focus goes to
  // this panel's heading instead. It acts only on that loss: focus resting on
  // any real element is left where the guest put it. And only while this panel
  // is the one on screen, so a hidden panel never pulls focus into itself.
  let heading: HTMLHeadingElement | undefined;
  let wasOffered = rsvpOffered();
  createEffect(() => {
    const offered = rsvpOffered();
    const withdrawn = wasOffered && !offered;
    wasOffered = offered;
    if (!withdrawn || !heading || props.active === false) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body) heading.focus();
  });

  return (
    <>
      <header class="mb-7">
        {/* The eyebrow is part of the heading, not a paragraph above it. The
            sheet moves focus here when the guest switches panels, and both
            panels' titles are the event's name — so "Details" is what tells a
            screen-reader user which panel they have arrived on. The comma is
            for the ear only. */}
        <h3
          id={titleId}
          ref={(el) => {
            heading = el;
            props.headingRef?.(el);
          }}
          tabindex="-1"
          class="font-display text-text text-ui-xl mb-5 leading-tight font-light italic"
        >
          <span class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 block leading-normal [font-weight:var(--invite-body-weight,400)] uppercase [font-style:var(--invite-body-style,normal)]">
            Details
            <span class="sr-only">,</span>
          </span>{" "}
          {props.event.name}
        </h3>
        {/* Answering is the one act that matters on the invite (see
            `EventCard`), so the way to the RSVP form is the call to action
            here and Add to Calendar stays secondary. It sits second, on the
            side the form slides in from. */}
        <div class="flex flex-wrap items-center gap-3">
          <AddToCalendar event={props.event} siteUrl={props.siteUrl} />
          <Show when={rsvpOffered() ? props.onRsvp : undefined}>
            {(openRsvp) => (
              <Button variant="cta" class="min-h-11" onClick={() => openRsvp()()}>
                RSVP for this event
                <span aria-hidden="true">→</span>
              </Button>
            )}
          </Show>
          {/* Rendered whether or not RSVPs have closed, and empty while they
              are open: assistive tech announces a change inside a live region
              it was already watching, so a deadline that passes with this
              panel open is heard, not just seen. */}
          <p
            class="font-body text-text-muted text-ui-sm"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not `<output>`: that element is form-associated, and this line is a notice about the wedding, not the result of anything the guest did.
            role="status"
          >
            {props.rsvpClosed
              ? props.rsvpClosedOn
                ? `RSVPs closed on ${props.rsvpClosedOn}.`
                : "RSVPs have closed."
              : ""}
          </p>
        </div>
      </header>

      <div class="flex flex-col gap-6">
        <Show when={day()}>
          <Section label="When">
            <p class="font-body text-text text-ui-md font-light">{day()}</p>
            <Show when={timeRange()}>
              <p class="font-body text-text-muted text-ui-base mt-1">
                {timeRange()}
                <Show when={tz()}>
                  <span class="text-text-muted/80"> · {tz()}</span>
                </Show>
              </p>
            </Show>
          </Section>
        </Show>

        <Section label="Where">
          <MapPreview event={props.event} />
        </Section>

        <Show when={props.event.description}>
          {(description) => (
            <Section label="About">
              <p class="font-body text-text-muted text-ui-base leading-ui-relaxed font-light whitespace-pre-line">
                {description()}
              </p>
            </Section>
          )}
        </Show>

        <Show when={hasDressCode(props.event.dressCodeDescription, props.event.dressCodePalette)}>
          <Section label="Dress Code">
            <Show when={props.event.dressCodeDescription}>
              {(desc) => (
                <p class="font-body text-text-muted text-ui-base leading-ui-normal mb-5 font-light">
                  {desc()}
                </p>
              )}
            </Show>

            <Show when={props.event.dressCodePalette}>
              {(palette) => (
                <div class="flex flex-wrap gap-5">
                  <For each={palette()}>
                    {(swatch) => (
                      <Show when={isValidColor(swatch.color)}>
                        <div class="flex flex-col items-center gap-2">
                          <div
                            class="border-border h-12 w-12 rounded-full border"
                            style={{ "background-color": swatch.color }}
                            aria-label={`${truncateSwatchName(swatch.name)} swatch`}
                          />
                          <span class="font-body text-text-muted text-ui-xs tracking-ui-wider uppercase">
                            {truncateSwatchName(swatch.name)}
                          </span>
                        </div>
                      </Show>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </Section>
        </Show>

        <Show when={hasPinterest(props.event.pinterestUrl) ? props.event.pinterestUrl : null}>
          {(url) => (
            <Section label="Inspiration">
              <PinterestBoard url={url()} eventName={props.event.name} />
            </Section>
          )}
        </Show>
      </div>
    </>
  );
}
