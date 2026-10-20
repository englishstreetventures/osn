import Button from "@cire/ui/button";
import { createEffect, createSignal, createUniqueId, For, onMount, Show, type JSX } from "solid-js";

import { AddToCalendar } from "./AddToCalendar";
import { isValidColor, truncateSwatchName } from "./dress-code-render";
import {
  formatEventDay,
  formatTimeRange,
  guestLocalTime,
  guestTimeZone,
  invitedNames,
  timezoneName,
} from "./event-details";
import { hasDescription, hasDressCode, hasPinterest, hasVenue } from "./invite-emptiness";
import { MapPreview } from "./MapPreview";
import { PinterestBoard } from "./PinterestBoard";
import type { EventSummary, FamilyMember } from "./types";

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
   * The wedding's RSVP deadline has passed, and a line says so. The RSVP
   * button follows the event card's: a household with a reply on file
   * (`replied`) keeps a way in, relabelled "View your RSVP", to the sheet's
   * read-only form; one with none loses it.
   */
  rsvpClosed?: boolean;
  /**
   * True once any invited member of the household has a reply on file for
   * this event (`hasAnyHouseholdReply`). Only matters once `rsvpClosed`.
   */
  replied?: boolean;
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
  /**
   * The household, for the "Who's invited" row: shown only when someone the
   * couple invited is NOT invited to this event. Absent ⇒ no row.
   */
  members?: ReadonlyArray<FamilyMember>;
}

/** A labelled section of the occasion, fronted by the gold eyebrow. */
function Section(props: { label: string; children: JSX.Element }) {
  return (
    <section>
      <h4 class="font-body text-gold-ink text-ui-xs tracking-ui-ultra mb-3 font-normal uppercase">
        {props.label}
      </h4>
      {props.children}
    </section>
  );
}

/** Functions, not elements: a Solid element is one DOM node, and each row needs its own. */
const ICON_PATHS = {
  when: () => (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </>
  ),
  where: () => (
    <>
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  who: () => (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.8-3.2 2.9-5 5.5-5s4.7 1.8 5.5 5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 14.2c2.4.1 4.2 1.7 5 4.8" />
    </>
  ),
} as const;

/**
 * One row of the key facts: a gold glyph and a screen-reader term in the
 * `<dt>`, the facts in the `<dd>`. The glyph is a graphical object (3:1, not
 * 4.5:1), so it takes the metal gold; the term is what a screen reader reads.
 */
function Fact(props: { term: string; icon: keyof typeof ICON_PATHS; children: JSX.Element }) {
  return (
    <div class="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3">
      <dt class="pt-0.5">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="text-gold"
          aria-hidden="true"
        >
          {ICON_PATHS[props.icon]()}
        </svg>
        <span class="sr-only">{props.term}</span>
      </dt>
      <dd class="min-w-0">{props.children}</dd>
    </div>
  );
}

/**
 * The holistic "everything about this event" view, one of `EventSheet`'s two
 * panels. Under the title come the key facts a guest needs, each with the one
 * action that belongs to it: when (timezone spelt out, the guest's own local
 * time beside it when that differs, Add to calendar), where (the address, a
 * compact map, Open in maps), and — for a household where not everyone is
 * invited — who is. One hairline, then the occasion: About, Dress Code with
 * its colours, and the Pinterest inspiration board.
 *
 * Every row and section renders only when it has content, so a sparse event
 * collapses to its title and its date rather than showing empty shells.
 */
export function DetailsPanel(props: DetailsPanelProps) {
  const day = () => formatEventDay(props.event);
  const timeRange = () => formatTimeRange(props.event);
  const tz = () => timezoneName(props.event);
  // The guest's own zone is read after mount: it is the browser's, and the
  // panel must render the same markup wherever it is first drawn.
  const [zone, setZone] = createSignal<string>();
  onMount(() => setZone(guestTimeZone()));
  const localTime = () => {
    const guest = zone();
    return guest === undefined ? null : guestLocalTime(props.event, guest);
  };
  const invited = () => (props.members ? invitedNames(props.members, props.event.id) : null);
  const venue = () => hasVenue(props.event.address, props.event.mapsUrl);
  const about = () => hasDescription(props.event.description);
  const dressCode = () =>
    hasDressCode(props.event.dressCodeDescription, props.event.dressCodePalette);
  const inspiration = () => hasPinterest(props.event.pinterestUrl);
  const titleId = props.titleId ?? createUniqueId();
  const rsvpOffered = () =>
    props.onRsvp !== undefined && (props.rsvpClosed !== true || props.replied === true);

  // The deadline can pass while this panel is open, and for a household with
  // no reply the RSVP button goes with it. (One with a reply keeps the same
  // button under a new label, so its focus never moves.) If focus was ON that
  // button, the browser drops it to `<body>` —
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

  const closedLine = () => {
    const when = props.rsvpClosedOn
      ? `RSVPs closed on ${props.rsvpClosedOn}.`
      : "RSVPs have closed.";
    const next = props.replied
      ? "To change your household's reply, please contact the couple directly."
      : "To reply now, please contact the couple directly.";
    return `${when} ${next}`;
  };

  return (
    <>
      <header class="mb-6">
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
            here, and the first control in the panel. */}
        <div class="flex flex-wrap items-center gap-3">
          <Show when={rsvpOffered() ? props.onRsvp : undefined}>
            {(openRsvp) => (
              <Button variant="cta" class="min-h-11" onClick={() => openRsvp()()}>
                {props.rsvpClosed ? "View your RSVP" : "RSVP for this event"}
                <span aria-hidden="true">→</span>
              </Button>
            )}
          </Show>
        </div>
        {/* Rendered whether or not RSVPs have closed, and empty while they
            are open: assistive tech announces a change inside a live region
            it was already watching, so a deadline that passes with this
            panel open is heard, not just seen. The line inside takes the
            closed treatment every other closed notice on the invite uses. */}
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not `<output>`: that element is form-associated, and this line is a notice about the wedding, not the result of anything the guest did.
          role="status"
        >
          <Show when={props.rsvpClosed}>
            <p
              class="border-border font-body text-text-muted text-ui-sm rounded-sm border px-4 py-3"
              classList={{ "mt-4": rsvpOffered() }}
            >
              {closedLine()}
            </p>
          </Show>
        </div>
      </header>

      <dl class="flex flex-col gap-5">
        <Show when={day()}>
          <Fact term="When" icon="when">
            <p class="font-body text-text text-ui-md font-light">{day()}</p>
            <Show when={timeRange()}>
              <p class="font-body text-text-muted text-ui-base mt-0.5">
                {timeRange()}
                <Show when={tz()}> · {tz()}</Show>
              </p>
            </Show>
            <Show when={localTime()}>
              {(local) => (
                <p class="font-body text-text-muted text-ui-sm mt-0.5">Your time: {local()}</p>
              )}
            </Show>
            <div class="mt-1 flex">
              <AddToCalendar event={props.event} siteUrl={props.siteUrl} />
            </div>
          </Fact>
        </Show>

        <Show when={venue()}>
          <Fact term="Where" icon="where">
            <MapPreview event={props.event} />
          </Fact>
        </Show>

        <Show when={invited()}>
          {(names) => (
            <Fact term="Who's invited" icon="who">
              <p class="font-body text-text text-ui-base font-light">
                <span aria-hidden="true">Invited: </span>
                {names()}
              </p>
            </Fact>
          )}
        </Show>
      </dl>

      <Show when={about() || dressCode() || inspiration()}>
        <div class="border-border/80 mt-7 flex flex-col gap-8 border-t pt-7">
          <Show when={about()}>
            <Section label="About">
              <p class="font-body text-text-muted text-ui-base leading-ui-relaxed font-light whitespace-pre-line">
                {props.event.description}
              </p>
            </Section>
          </Show>

          <Show when={dressCode()}>
            <Section label="Dress Code">
              <Show when={props.event.dressCodeDescription?.trim()}>
                {(desc) => (
                  <p class="font-body text-text-muted text-ui-base leading-ui-normal mb-5 font-light">
                    {desc()}
                  </p>
                )}
              </Show>

              <Show when={props.event.dressCodePalette}>
                {(palette) => (
                  <ul class="grid grid-cols-[repeat(auto-fill,minmax(3.75rem,1fr))] gap-x-2 gap-y-4">
                    <For each={palette()}>
                      {(swatch) => (
                        <Show when={isValidColor(swatch.color)}>
                          <li class="flex flex-col items-center gap-2 text-center">
                            {/* The edge is the strong border, held to 3:1 on
                                every surface, so a swatch the colour of the
                                sheet still has an outline. */}
                            <span
                              aria-hidden="true"
                              class="border-border-strong h-11 w-11 rounded-full border"
                              style={{ "background-color": swatch.color }}
                            />
                            <span class="font-body text-text-muted text-ui-xs w-full leading-snug wrap-anywhere">
                              {truncateSwatchName(swatch.name) || (
                                <span class="sr-only">Unnamed colour</span>
                              )}
                            </span>
                          </li>
                        </Show>
                      )}
                    </For>
                  </ul>
                )}
              </Show>
            </Section>
          </Show>

          <Show when={inspiration() ? props.event.pinterestUrl!.trim() : null}>
            {(url) => (
              <Section label="Inspiration">
                <PinterestBoard url={url()} eventName={props.event.name} />
              </Section>
            )}
          </Show>
        </div>
      </Show>
    </>
  );
}
