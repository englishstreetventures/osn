import { createUniqueId, For, Show, type JSX } from "solid-js";

import { AddToCalendar } from "./AddToCalendar";
import { AnimatedModal } from "./AnimatedModal";
import { isValidColor, truncateSwatchName } from "./dress-code-render";
import { formatEventDay, formatTimeRange, timezoneLabel } from "./event-details";
import { MapPreview } from "./MapPreview";
import { PinterestBoard } from "./PinterestBoard";
import type { EventSummary } from "./types";

interface DetailsModalProps {
  event: EventSummary;
  /** Origin used to stamp the calendar invite's "Invite:" link. */
  siteUrl: string;
  onClose: () => void;
}

/** A labelled section in the holistic event view, fronted by the gold eyebrow. */
function Section(props: { label: string; children: JSX.Element }) {
  return (
    <section class="border-border/80 border-t pt-6">
      <h4 class="font-body text-gold mb-3 text-[0.68rem] font-normal tracking-[0.22em] uppercase">
        {props.label}
      </h4>
      {props.children}
    </section>
  );
}

/**
 * The holistic "everything about this event" view. Opened from an EventCard, it
 * gathers — in one cohesive sheet — when the event runs (timezone-aware), a
 * branded map preview of the venue with an Open-in-Maps action, an Add-to-
 * Calendar control (relocated here from the outer card), the description, the
 * dress code with its colour palette, and the Pinterest inspiration board.
 *
 * Every section renders only when it has content, so a sparse event collapses
 * gracefully to just its header and timing rather than showing empty shells.
 */
export function DetailsModal(props: DetailsModalProps) {
  const day = () => formatEventDay(props.event);
  const timeRange = () => formatTimeRange(props.event);
  const tz = () => timezoneLabel(props.event);
  const titleId = createUniqueId();

  return (
    <AnimatedModal onClose={props.onClose} labelledBy={titleId}>
      <header class="mb-7">
        <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">Details</p>
        <h3
          id={titleId}
          class="font-display text-text mb-5 text-[1.7rem] leading-tight font-light italic"
        >
          {props.event.name}
        </h3>
        <AddToCalendar event={props.event} siteUrl={props.siteUrl} variant="primary" />
      </header>

      <div class="flex flex-col gap-6">
        <Show when={day()}>
          <Section label="When">
            <p class="font-body text-text text-[0.98rem] font-light">{day()}</p>
            <Show when={timeRange()}>
              <p class="font-body text-text-muted mt-1 text-[0.9rem]">
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
              <p class="font-body text-text-muted text-[0.92rem] leading-[1.7] font-light whitespace-pre-line">
                {description()}
              </p>
            </Section>
          )}
        </Show>

        <Show when={props.event.dressCodeDescription || props.event.dressCodePalette}>
          <Section label="Dress Code">
            <Show when={props.event.dressCodeDescription}>
              {(desc) => (
                <p class="font-body text-text-muted mb-5 text-[0.92rem] leading-[1.65] font-light">
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
                          <span class="font-body text-text-muted text-[0.72rem] tracking-[0.08em] uppercase">
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

        <Show when={props.event.pinterestUrl}>
          {(url) => (
            <Section label="Inspiration">
              <PinterestBoard url={url()} eventName={props.event.name} />
            </Section>
          )}
        </Show>
      </div>
    </AnimatedModal>
  );
}
