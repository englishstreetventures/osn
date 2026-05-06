import { createSignal, Show, For } from "solid-js";
import { LoginSection } from "./LoginSection";
import { EventCard } from "./EventCard";
import { RsvpModal } from "./RsvpModal";
import { DetailsModal } from "./DetailsModal";
import type { ClaimResult, EventSummary, RsvpSummary } from "./types";

interface InvitePageProps {
  apiUrl: string;
  siteUrl?: string;
}

export default function InvitePage(props: InvitePageProps) {
  const [claimResult, setClaimResult] = createSignal<ClaimResult | null>(null);
  const [rsvpEvent, setRsvpEvent] = createSignal<EventSummary | null>(null);
  const [detailsEvent, setDetailsEvent] = createSignal<EventSummary | null>(null);

  const siteUrl = () =>
    props.siteUrl ?? (typeof window !== "undefined" ? window.location.origin : "");

  let loginFormRef: HTMLDivElement;
  let welcomeRef: HTMLDivElement;
  let eventsSectionRef: HTMLElement;

  async function handleClaimed(result: ClaimResult) {
    setClaimResult(result);

    // Wait a tick so SolidJS renders the events section into the DOM
    await new Promise((r) => setTimeout(r, 0));

    if (loginFormRef && welcomeRef && eventsSectionRef) {
      const { unlockRevealSequence } = await import("./UnlockReveal.motion");
      unlockRevealSequence(loginFormRef, welcomeRef, eventsSectionRef);
    }
  }

  return (
    <>
      <LoginSection
        apiUrl={props.apiUrl}
        result={claimResult()}
        onClaimed={handleClaimed}
        formRef={(el) => (loginFormRef = el)}
        welcomeRef={(el) => (welcomeRef = el)}
      />

      <Show when={claimResult()}>
        {(data) => (
          <section
            ref={eventsSectionRef}
            class="border-y border-border bg-surface px-6 py-16 opacity-0 md:px-8 md:py-20"
          >
            <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
              <p class="mb-3 font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">
                Celebrate With Us
              </p>
              <h2 class="mb-5 font-display text-[clamp(2rem,5vw,3rem)] font-light italic leading-[1.15] text-text">
                Your Events
              </h2>
              <div class="flex flex-col gap-5 text-left">
                <For each={data().events}>
                  {(event) => (
                    <div data-event-card>
                      <EventCard
                        event={event}
                        siteUrl={siteUrl()}
                        onRespond={setRsvpEvent}
                        onDetails={setDetailsEvent}
                      />
                    </div>
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
            members={claimResult()!.members}
            existingRsvps={claimResult()!.rsvps}
            apiUrl={props.apiUrl}
            onClose={() => setRsvpEvent(null)}
            onSubmitted={(updated: RsvpSummary[]) => {
              const current = claimResult();
              if (!current) return;
              setClaimResult({ ...current, rsvps: updated });
            }}
          />
        )}
      </Show>

      <Show when={detailsEvent()}>
        {(event) => <DetailsModal event={event()} onClose={() => setDetailsEvent(null)} />}
      </Show>
    </>
  );
}
