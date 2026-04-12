import type { EventSummary } from "./types"
import { formatDate } from "./utils"

interface EventCardProps {
  event: EventSummary
  onRespond: (event: EventSummary) => void
  onDetails: (event: EventSummary) => void
}

export function EventCard(props: EventCardProps) {
  return (
    <article class="event-card">
      <h3 class="event-name">{props.event.name}</h3>
      <p class="event-date">{formatDate(props.event.date)}</p>
      <p class="event-location">{props.event.location}</p>
      <p class="event-desc">{props.event.description}</p>
      <div class="event-actions">
        <button
          class="event-respond-btn"
          onClick={() => props.onRespond(props.event)}
        >
          Respond
        </button>
        <button
          class="event-details-btn"
          onClick={() => props.onDetails(props.event)}
        >
          More Details
        </button>
      </div>
    </article>
  )
}
