import Button from "@cire/ui/button";
import { createEffect, createSignal, createUniqueId, For, onMount, Show, type JSX } from "solid-js";

import { AddToCalendar } from "./AddToCalendar";
import { isValidColor, truncateSwatchName } from "./dress-code-render";
import {
  browserTimeZone,
  formatEventDay,
  formatTimeRange,
  guestLocalTime,
  invitedNames,
  timezoneName,
} from "./event-details";
import { hasDressCode, hasPinterest, hasText, hasVenue } from "./invite-emptiness";
import { MapPreview } from "./MapPreview";
import { PinterestBoard } from "./PinterestBoard";
import type { EventSummary, FamilyMember } from "./types";

export interface DetailsPanelProps {
  event: EventSummary;
  /** Origin used to stamp the calendar invite's "Invite:" link. */
  siteUrl: string;
  /**
   * The household, for the "who's invited" line, which shows only when some
   * member the couple invited is not invited to this event. Absent ⇒ no line.
   */
  members?: readonly FamilyMember[];
  /**
   * Moves the sheet to the event's RSVP form. Absent ⇒ no "RSVP for this
   * event" button (a panel rendered on its own).
   */
  onRsvp?: () => void;
  /**
   * The wedding's RSVP deadline has passed, and a notice says so. The RSVP
   * button follows the event card's: a household with a reply on file
   * (`replied`) keeps a way in, relabelled "View your RSVP", to the sheet's
   * read-only form; one with none loses it.
   */
  rsvpClosed?: boolean;
  /**
   * True once any invited member of the household has a reply on file for
   * this event (`hasAnyHouseholdReply`). Only matters once `rsvpClosed`: it
   * keeps the RSVP button, and it decides the closed notice's next step.
   */
  replied?: boolean;
  /** The deadline day in words, for the closed notice ("RSVPs closed on …"). */
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

/** A labelled part of the occasion, under its gold eyebrow. */
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

/**
 * One row of the key facts: a glyph in the metal and the term it stands for,
 * then the fact. The term is for assistive technology; the glyph says it on
 * screen. The glyph is a graphical object, so the metal, held to 3:1, is its
 * colour rather than the prose gold.
 */
function Fact(props: { term: string; icon: JSX.Element; children: JSX.Element }) {
  return (
    <div class="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3">
      <dt class="text-gold pt-0.5">
        <span aria-hidden="true">{props.icon}</span>
        <span class="sr-only">{props.term}</span>
      </dt>
      <dd class="m-0 min-w-0">{props.children}</dd>
    </div>
  );
}

/** An 18px line glyph drawn in the current colour. */
function Glyph(props: { children: JSX.Element }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="block"
    >
      {props.children}
    </svg>
  );
}

function CalendarGlyph() {
  return (
    <Glyph>
      <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </Glyph>
  );
}

function PinGlyph() {
  return (
    <Glyph>
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.4" />
    </Glyph>
  );
}

function PeopleGlyph() {
  return (
    <Glyph>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5" />
      <circle cx="17" cy="9" r="2.3" />
      <path d="M15.5 14.2c2.3.2 4 1.9 4.5 4.8" />
    </Glyph>
  );
}

/**
 * The holistic "everything about this event" view, one of `EventSheet`'s two
 * panels.
 *
 * It leads with the plan, the facts a guest opens it for, as a short list under
 * the heading and the way to the RSVP form: when (in the event's own zone,
 * spelt out, and on the guest's own clock where that reads differently, with
 * Add to calendar on the row), where (the address, a small map and Open in
 * maps), and — for a household not all of whom are asked — who is invited.
 * One hairline, then the occasion: about, the dress code, and the moodboard.
 *
 * Every row and section renders only when it has content, so a sparse event —
 * a name, a start and a timezone — collapses to its heading, the RSVP button
 * and its date, with no empty label and no hairline over nothing.
 */
export function DetailsPanel(props: DetailsPanelProps) {
  const day = () => formatEventDay(props.event);
  const timeRange = () => formatTimeRange(props.event);
  const zone = () => timezoneName(props.event);
  const titleId = props.titleId ?? createUniqueId();
  const rsvpOffered = () =>
    props.onRsvp !== undefined && (props.rsvpClosed !== true || props.replied === true);
  const invited = () => invitedNames(props.members ?? [], props.event.id);
  const description = () => (hasText(props.event.description) ? props.event.description : null);
  const dressCode = () =>
    hasDressCode(props.event.dressCodeDescription, props.event.dressCodePalette);
  const moodboard = () =>
    hasPinterest(props.event.pinterestUrl) ? props.event.pinterestUrl : null;
  const swatches = () =>
    (props.event.dressCodePalette ?? []).filter((swatch) => isValidColor(swatch.color));

  // The guest's own clock is read in the browser, once mounted, so the first
  // render matches a server render whatever zone the server ran in.
  const [guestZone, setGuestZone] = createSignal<string | null>(null);
  onMount(() => setGuestZone(browserTimeZone()));
  const localTime = () => {
    const theirs = guestZone();
    return theirs ? guestLocalTime(props.event, theirs) : null;
  };

  // Past the deadline: when replies shut, and the one way still open to the
  // household — the couple, directly — as the RSVP form's own notice puts it.
  const closedNotice = () => {
    if (!props.rsvpClosed) return null;
    const when = props.rsvpClosedOn
      ? `RSVPs closed on ${props.rsvpClosedOn}.`
      : "RSVPs have closed.";
    const next = props.replied
      ? "To change your household's reply, please contact the couple directly."
      : "To reply now, please contact the couple directly.";
    return `${when} ${next}`;
  };

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
            here, the first thing to press under the heading. */}
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
            panel open is heard, not just seen. Only its contents come and
            go — the closed notice's box with them — never the region. */}
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not `<output>`: that element is form-associated, and this is a notice about the wedding, not the result of anything the guest did.
          role="status"
        >
          <Show when={closedNotice()}>
            {(notice) => (
              // The closed treatment `RsvpDeadlineNotice` gives the same
              // fact: a hairline box, muted ink, nothing washed behind it.
              <p
                class="font-body text-ui-sm leading-ui-normal border-border text-text-muted rounded-sm border px-4 py-3"
                classList={{ "mt-4": rsvpOffered() }}
              >
                {notice()}
              </p>
            )}
          </Show>
        </div>
      </header>

      {/* The plan: the facts a guest opens this for, before any decoration. */}
      <dl class="m-0 flex flex-col gap-5">
        <Show when={day()}>
          <Fact term="When" icon={<CalendarGlyph />}>
            <p class="font-body text-text text-ui-md font-light">{day()}</p>
            <Show when={timeRange()}>
              <p class="font-body text-text-muted text-ui-base mt-0.5">
                {timeRange()}
                <Show when={zone()}>{(name) => <> · {name()}</>}</Show>
              </p>
            </Show>
            <Show when={localTime()}>
              {(local) => (
                <p class="font-body text-text-muted text-ui-sm mt-0.5">Your time: {local()}</p>
              )}
            </Show>
            <AddToCalendar event={props.event} siteUrl={props.siteUrl} />
          </Fact>
        </Show>

        <Show when={hasVenue(props.event.address, props.event.mapsUrl)}>
          <Fact term="Where" icon={<PinGlyph />}>
            <MapPreview event={props.event} />
          </Fact>
        </Show>

        <Show when={invited()}>
          {(names) => (
            <Fact term="Who's invited" icon={<PeopleGlyph />}>
              <p class="font-body text-text text-ui-base font-light">
                {/* The term already says it to assistive technology. */}
                <span aria-hidden="true">Invited: </span>
                {names()}
              </p>
            </Fact>
          )}
        </Show>
      </dl>

      {/* The occasion, under one hairline, and only when there is any. */}
      <Show when={description() || dressCode() || moodboard()}>
        <div class="border-border/80 mt-7 flex flex-col gap-8 border-t pt-7">
          <Show when={description()}>
            {(text) => (
              <Section label="About">
                <p class="font-body text-text-muted text-ui-base leading-ui-relaxed font-light whitespace-pre-line">
                  {text()}
                </p>
              </Section>
            )}
          </Show>

          <Show when={dressCode()}>
            <Section label="Dress Code">
              <Show when={props.event.dressCodeDescription}>
                {(desc) => (
                  <p class="font-body text-text-muted text-ui-base leading-ui-normal mb-5 font-light">
                    {desc()}
                  </p>
                )}
              </Show>

              {/* A list of colours, each named as the organiser wrote it. The
                  circle is the colour itself and says nothing the name does
                  not, so it is hidden from assistive technology; its ring is
                  the control boundary, held to 3:1 on every scheme, so a dark
                  colour on a dark invite still has an edge. A fixed column
                  width (five across at 390px) keeps the names in a grid. */}
              <Show when={swatches().length > 0}>
                <ul class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(3.75rem,1fr))] gap-x-2 gap-y-4 p-0">
                  <For each={swatches()}>
                    {(swatch) => (
                      <li class="flex flex-col items-center gap-2 text-center">
                        <span
                          aria-hidden="true"
                          class="border-border-strong h-11 w-11 rounded-full border"
                          style={{ "background-color": swatch.color }}
                        />
                        <span class="font-body text-text-muted text-ui-xs leading-ui-snug max-w-full wrap-anywhere">
                          {truncateSwatchName(swatch.name)}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Section>
          </Show>

          <Show when={moodboard()}>
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
