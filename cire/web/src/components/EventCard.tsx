import { AddToCalendar } from "./AddToCalendar";
import type { EventSummary } from "./types";
import { formatDate } from "./utils";

interface EventCardProps {
  event: EventSummary;
  siteUrl: string;
  /** Host preview session — RSVP is disabled. */
  preview?: boolean;
  onRespond: (event: EventSummary) => void;
  onDetails: (event: EventSummary) => void;
}

export function EventCard(props: EventCardProps) {
  return (
    <article class="border-border bg-surface-raised rounded-sm border px-6 py-7">
      <h3 class="font-display text-text mb-2 text-2xl font-normal italic">{props.event.name}</h3>
      <p class="font-body text-gold mb-1 text-[0.78rem] tracking-[0.12em] uppercase">
        {formatDate(props.event.date)}
      </p>
      <p class="font-body text-text-muted mb-3 text-[0.88rem]">{props.event.location}</p>
      <p class="font-body text-text-muted mb-5 text-[0.88rem] leading-[1.65] font-light">
        {props.event.description}
      </p>
      <div class="flex flex-wrap gap-3">
        <button
          class="border-gold font-body text-gold hover:bg-gold hover:text-bg disabled:hover:text-gold rounded-sm border bg-transparent px-5 py-2.5 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          onClick={() => props.onRespond(props.event)}
          disabled={props.preview}
          title={props.preview ? "RSVP is disabled in preview mode" : undefined}
        >
          Respond
        </button>
        <button
          class="border-border font-body text-text-muted hover:border-gold hover:text-gold rounded-sm border bg-transparent px-5 py-2.5 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200"
          onClick={() => props.onDetails(props.event)}
        >
          More Details
        </button>
        <AddToCalendar event={props.event} siteUrl={props.siteUrl} />
      </div>
    </article>
  );
}
