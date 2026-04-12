import { createSignal, Show, For } from "solid-js"
import { LoginSection } from "./LoginSection"
import { EventCard } from "./EventCard"
import { RsvpModal } from "./RsvpModal"
import { DetailsModal } from "./DetailsModal"
import type { ClaimResult, EventSummary } from "./types"
import "./InvitePage.css"

interface InvitePageProps {
  apiUrl: string
}

export default function InvitePage(props: InvitePageProps) {
  const [claimResult, setClaimResult] = createSignal<ClaimResult | null>(null)
  const [rsvpEvent, setRsvpEvent] = createSignal<EventSummary | null>(null)
  const [detailsEvent, setDetailsEvent] = createSignal<EventSummary | null>(
    null,
  )

  return (
    <>
      <LoginSection
        apiUrl={props.apiUrl}
        result={claimResult()}
        onClaimed={setClaimResult}
      />

      <Show when={claimResult()}>
        {(data) => (
          <section class="section events-section">
            <div class="section-inner">
              <p class="section-eyebrow">Celebrate With Us</p>
              <h2 class="section-heading">Your Events</h2>
              <div class="events-list">
                <For each={data().events}>
                  {(event) => (
                    <EventCard
                      event={event}
                      onRespond={setRsvpEvent}
                      onDetails={setDetailsEvent}
                    />
                  )}
                </For>
              </div>
            </div>
          </section>
        )}
      </Show>

      <Show when={rsvpEvent()}>
        {(event) => (
          <RsvpModal
            event={event()}
            guestName={claimResult()!.guestName}
            onClose={() => setRsvpEvent(null)}
          />
        )}
      </Show>

      <Show when={detailsEvent()}>
        {(event) => (
          <DetailsModal event={event()} onClose={() => setDetailsEvent(null)} />
        )}
      </Show>
    </>
  )
}
