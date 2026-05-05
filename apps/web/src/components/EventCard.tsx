import type { EventSummary } from "./types";
import { formatDate } from "./utils";

interface EventCardProps {
  event: EventSummary;
  onRespond: (event: EventSummary) => void;
  onDetails: (event: EventSummary) => void;
}

export function EventCard(props: EventCardProps) {
  return (
    <article class="rounded-sm border border-border bg-surface-raised px-6 py-7">
      <h3 class="mb-2 font-display text-2xl font-normal italic text-text">{props.event.name}</h3>
      <p class="mb-1 font-body text-[0.78rem] uppercase tracking-[0.12em] text-gold">
        {formatDate(props.event.date)}
      </p>
      <p class="mb-3 font-body text-[0.88rem] text-text-muted">{props.event.location}</p>
      <p class="mb-5 font-body text-[0.88rem] font-light leading-[1.65] text-text-muted">
        {props.event.description}
      </p>
      <div class="flex gap-3">
        <button
          class="rounded-sm border border-gold bg-transparent px-5 py-2.5 font-body text-[0.82rem] uppercase tracking-[0.12em] text-gold transition-colors duration-200 hover:bg-gold hover:text-bg"
          onClick={() => props.onRespond(props.event)}
        >
          Respond
        </button>
        <button
          class="rounded-sm border border-border bg-transparent px-5 py-2.5 font-body text-[0.82rem] uppercase tracking-[0.12em] text-text-muted transition-colors duration-200 hover:border-gold hover:text-gold"
          onClick={() => props.onDetails(props.event)}
        >
          More Details
        </button>
      </div>
    </article>
  );
}
