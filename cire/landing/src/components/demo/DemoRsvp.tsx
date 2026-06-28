import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";

import { DemoModal } from "./DemoModal";

// A self-contained, no-backend preview of a Cire invitation. Everything is
// interactive — you can pick events, toggle attendance, type a dietary note and
// "send" — but the RSVP is a deliberate NO-OP: nothing leaves the browser. This
// mirrors the real guest flow closely enough to feel live while making clear it
// is a demonstration. The same no-op treatment is used for the organiser host
// preview in cire/web (the RSVP there used to be greyed out).

interface DemoMember {
  guestId: string;
  firstName: string;
  lastName: string;
  eventIds: string[];
}

interface DemoEvent {
  id: string;
  name: string;
  date: string;
  location: string;
  description: string;
}

const DEMO_EVENTS: DemoEvent[] = [
  {
    id: "ceremony",
    name: "The Ceremony",
    date: "Saturday, 17 October 2026",
    location: "Cliffside Chapel, Byron Bay",
    description: "Vows at golden hour, followed by canapés on the lawn.",
  },
  {
    id: "reception",
    name: "The Reception",
    date: "Saturday, 17 October 2026",
    location: "The Glasshouse, Byron Bay",
    description: "Dinner, dancing and a little late-night magic.",
  },
];

const DEMO_MEMBERS: DemoMember[] = [
  {
    guestId: "g-amara",
    firstName: "Amara",
    lastName: "Reyes",
    eventIds: ["ceremony", "reception"],
  },
  { guestId: "g-sam", firstName: "Sam", lastName: "Reyes", eventIds: ["ceremony", "reception"] },
];

type Attending = "attending" | "declined" | null;

export function DemoRsvp() {
  const [rsvpEvent, setRsvpEvent] = createSignal<DemoEvent | null>(null);

  return (
    <div class="border-border bg-surface-raised mx-auto max-w-[640px] overflow-hidden rounded-lg border shadow-2xl">
      {/* Faux browser chrome — signals "this is the real thing, in miniature". */}
      <div class="border-border flex items-center gap-2 border-b px-4 py-3">
        <span class="bg-error/60 h-2.5 w-2.5 rounded-full" aria-hidden="true" />
        <span class="bg-gold/50 h-2.5 w-2.5 rounded-full" aria-hidden="true" />
        <span class="bg-success/50 h-2.5 w-2.5 rounded-full" aria-hidden="true" />
        <span class="font-body text-text-muted ml-2 text-[0.72rem] tracking-[0.08em]">
          cireweddings.com/amara-and-sam
        </span>
      </div>

      <div class="px-6 py-10 text-center md:px-10">
        <p class="font-body text-gold mb-3 text-[0.7rem] tracking-[0.24em] uppercase">
          Together with their families
        </p>
        <h3 class="font-display text-text mb-2 text-[clamp(2rem,6vw,2.75rem)] leading-[1.1] font-light italic">
          Amara &amp; Sam
        </h3>
        <p class="font-body text-text-muted mb-8 text-[0.9rem] font-light">
          request the pleasure of your company
        </p>

        <div class="flex flex-col gap-4 text-left">
          <For each={DEMO_EVENTS}>
            {(event) => (
              <article class="border-border bg-surface rounded-sm border px-5 py-5">
                <h4 class="font-display text-text mb-1 text-xl font-normal italic">{event.name}</h4>
                <p class="font-body text-gold mb-1 text-[0.74rem] tracking-[0.12em] uppercase">
                  {event.date}
                </p>
                <p class="font-body text-text-muted mb-2 text-[0.85rem]">{event.location}</p>
                <p class="font-body text-text-muted mb-4 text-[0.85rem] leading-[1.6] font-light">
                  {event.description}
                </p>
                <button
                  type="button"
                  class="border-gold font-body text-gold hover:bg-gold hover:text-bg min-h-11 rounded-sm border bg-transparent px-5 py-2.5 text-[0.8rem] tracking-[0.12em] uppercase transition-colors duration-200"
                  onClick={() => setRsvpEvent(event)}
                >
                  Respond
                </button>
              </article>
            )}
          </For>
        </div>

        <p class="font-body text-text-muted mt-6 text-[0.74rem] tracking-[0.06em]">
          This is an interactive preview — responses aren&rsquo;t saved.
        </p>
      </div>

      <Show when={rsvpEvent()}>
        {(event) => (
          <DemoRsvpModal
            event={event()}
            members={DEMO_MEMBERS}
            onClose={() => setRsvpEvent(null)}
          />
        )}
      </Show>
    </div>
  );
}

interface DemoRsvpModalProps {
  event: DemoEvent;
  members: DemoMember[];
  onClose: () => void;
}

interface MemberState {
  attending: Attending;
  dietary: string;
}

function DemoRsvpModal(props: DemoRsvpModalProps) {
  const eventMembers = createMemo(() =>
    props.members.filter((m) => m.eventIds.includes(props.event.id)),
  );

  const [responses, setResponses] = createSignal<Record<string, MemberState>>(
    Object.fromEntries(
      eventMembers().map((m) => [m.guestId, { attending: null, dietary: "" } as MemberState]),
    ),
  );
  const [error, setError] = createSignal<string | null>(null);
  const [submitted, setSubmitted] = createSignal(false);
  const titleId = createUniqueId();

  function setAttending(guestId: string, attending: Attending) {
    setResponses((prev) => ({ ...prev, [guestId]: { ...prev[guestId]!, attending } }));
  }
  function setDietary(guestId: string, dietary: string) {
    setResponses((prev) => ({ ...prev, [guestId]: { ...prev[guestId]!, dietary } }));
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    setError(null);
    const current = responses();
    const allAnswered = eventMembers().every((m) => current[m.guestId]?.attending !== null);
    if (!allAnswered) {
      setError("Please respond for everyone in your party.");
      return;
    }
    // The deliberate no-op: a real invite would POST here. The demo just confirms.
    setSubmitted(true);
  }

  return (
    <DemoModal onClose={props.onClose} labelledBy={titleId}>
      <Show
        when={!submitted()}
        fallback={
          <div class="py-6 text-center">
            <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
              Preview
            </p>
            <h3 class="font-display text-text mb-4 text-[1.6rem] font-light italic">
              That&rsquo;s the feeling.
            </h3>
            <p class="font-body text-text-muted mb-7 text-[0.9rem] leading-[1.6] font-light">
              On a real Cire invitation, your reply would be on its way to the couple and counted in
              their live guest dashboard. Here, nothing is saved — it&rsquo;s just a taste.
            </p>
            <button
              type="button"
              class="border-gold font-body text-gold hover:bg-gold hover:text-bg rounded-sm border bg-transparent px-6 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200"
              onClick={() => props.onClose()}
            >
              Close
            </button>
          </div>
        }
      >
        <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">Respond</p>
        <h3 id={titleId} class="font-display text-text mb-2 text-[1.6rem] font-light italic">
          {props.event.name}
        </h3>
        <p
          class="border-gold/40 bg-gold/5 text-gold mb-6 rounded-sm border px-3.5 py-2.5 text-[0.74rem] leading-relaxed"
          role="status"
        >
          Interactive preview — your reply won&rsquo;t be saved.
        </p>

        <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
          <For each={eventMembers()}>
            {(member) => {
              const guestId = member.guestId;
              return (
                <fieldset class="border-border m-0 rounded-sm border p-5">
                  <legend class="font-display text-text mb-3 text-[1.1rem] font-normal italic">
                    {member.firstName} {member.lastName}
                  </legend>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="font-body flex-1 cursor-pointer rounded-sm border px-3 py-2.5 text-[0.82rem] tracking-[0.06em] uppercase transition-colors duration-200"
                      classList={{
                        "border-gold text-gold bg-gold/8":
                          responses()[guestId]?.attending === "attending",
                        "border-border text-text-muted hover:border-gold-dim hover:text-text":
                          responses()[guestId]?.attending !== "attending",
                      }}
                      aria-pressed={responses()[guestId]?.attending === "attending"}
                      onClick={() => setAttending(guestId, "attending")}
                    >
                      Attending
                    </button>
                    <button
                      type="button"
                      class="font-body flex-1 cursor-pointer rounded-sm border px-3 py-2.5 text-[0.82rem] tracking-[0.06em] uppercase transition-colors duration-200"
                      classList={{
                        "border-gold text-gold bg-gold/8":
                          responses()[guestId]?.attending === "declined",
                        "border-border text-text-muted hover:border-gold-dim hover:text-text":
                          responses()[guestId]?.attending !== "declined",
                      }}
                      aria-pressed={responses()[guestId]?.attending === "declined"}
                      onClick={() => setAttending(guestId, "declined")}
                    >
                      Not attending
                    </button>
                  </div>
                  <Show when={responses()[guestId]?.attending === "attending"}>
                    <label class="font-body text-text-muted mt-3 block text-[0.78rem] tracking-[0.06em] uppercase">
                      Dietary requirements
                      <input
                        type="text"
                        class="border-border font-body text-text placeholder:text-text-muted focus:border-gold mt-1.5 block w-full rounded-sm border bg-transparent px-3 py-2.5 text-base transition-colors duration-200 focus:outline-none sm:text-[0.9rem]"
                        placeholder="e.g. Vegetarian, no nuts"
                        value={responses()[guestId]?.dietary ?? ""}
                        onInput={(e) => setDietary(guestId, e.currentTarget.value)}
                        maxLength={200}
                      />
                    </label>
                  </Show>
                </fieldset>
              );
            }}
          </For>

          <Show when={error()}>
            <p class="font-body text-error py-1 text-[0.82rem]" role="alert">
              {error()}
            </p>
          </Show>

          <div class="border-border bg-surface sticky bottom-0 -mx-6 -mb-[max(2.5rem,env(safe-area-inset-bottom))] flex gap-3 border-t px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:-mb-10 md:pb-4">
            <button
              type="button"
              class="border-border font-body text-text-muted hover:border-gold-dim hover:text-text flex-1 cursor-pointer rounded-sm border bg-transparent px-4 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200"
              onClick={() => props.onClose()}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="border-gold font-body text-gold hover:bg-gold hover:text-bg flex-1 cursor-pointer rounded-sm border bg-transparent px-4 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200"
            >
              Send RSVP
            </button>
          </div>
        </form>
      </Show>
    </DemoModal>
  );
}
