import { createMemo, createSignal, createUniqueId, For, onMount, Show, type JSX } from "solid-js";

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
  /** The wedding's RSVP deadline has passed, and a notice says so. */
  rsvpClosed?: boolean;
  /**
   * True once any invited member of the household has a reply on file for
   * this event (`hasAnyHouseholdReply`). Only matters once `rsvpClosed`: it
   * decides the closed notice's next step.
   */
  replied?: boolean;
  /** The deadline day in words, for the closed notice ("RSVPs closed on …"). */
  rsvpClosedOn?: string;
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
 * panels. The way to the RSVP form is the sheet's, in its chrome beside the
 * close button (`EventSheet`).
 *
 * It leads with the plan, the facts a guest opens it for, as a short list under
 * the heading: when (in the event's own zone,
 * spelt out, and on the guest's own clock where that reads differently, with
 * Add to calendar on the row), where (the address, a small map and Open in
 * maps), and — for a household not all of whom are asked — who is invited.
 * One hairline, then the occasion: about, the dress code, and the moodboard.
 *
 * Every row and section renders only when it has content, so a sparse event —
 * a name, a start and a timezone — collapses to its heading and its date,
 * with no empty label and no hairline over nothing.
 */
export function DetailsPanel(props: DetailsPanelProps) {
  // Memos: each is read by its `Show` and again inside it.
  const day = createMemo(() => formatEventDay(props.event));
  const timeRange = createMemo(() => formatTimeRange(props.event));
  const zone = createMemo(() => timezoneName(props.event));
  const titleId = props.titleId ?? createUniqueId();
  const invited = () => invitedNames(props.members ?? [], props.event.id);
  const description = () => (hasText(props.event.description) ? props.event.description : null);
  const swatches = () =>
    (props.event.dressCodePalette ?? []).filter((swatch) => isValidColor(swatch.color));
  // Only the colours that can be painted count: a palette of nothing but
  // refused colours is no dress code, and would leave the label over nothing.
  const dressCode = () => hasDressCode(props.event.dressCodeDescription, swatches());
  const dressCodeText = () =>
    hasText(props.event.dressCodeDescription) ? props.event.dressCodeDescription : null;
  const moodboard = () =>
    hasPinterest(props.event.pinterestUrl) ? props.event.pinterestUrl : null;

  // The guest's own clock is read in the browser, once mounted, so the first
  // render matches a server render whatever zone the server ran in.
  const [guestZone, setGuestZone] = createSignal<string | null>(null);
  onMount(() => setGuestZone(browserTimeZone()));
  const localTime = createMemo(() => {
    const theirs = guestZone();
    return theirs ? guestLocalTime(props.event, theirs) : null;
  });

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
          ref={(el) => props.headingRef?.(el)}
          tabindex="-1"
          class="font-display text-text text-ui-xl mb-5 leading-tight font-light italic"
        >
          <span class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 block leading-normal [font-weight:var(--invite-body-weight,400)] uppercase [font-style:var(--invite-body-style,normal)]">
            Details
            <span class="sr-only">,</span>
          </span>{" "}
          {props.event.name}
        </h3>
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
              <p class="font-body text-ui-sm leading-ui-normal border-border text-text-muted rounded-sm border px-4 py-3">
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
              <Show when={dressCodeText()}>
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
