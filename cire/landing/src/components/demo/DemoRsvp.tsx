import type { DietaryPreset } from "@cire/dietary";
import Button from "@cire/ui/button";
import DietaryPresets from "@cire/ui/dietary-presets";
import { heldWhileClosing } from "@shared/ui/ui/modal";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";

import { DemoModal } from "./DemoModal";

// A self-contained, no-backend preview of a Cire invitation. Everything is
// interactive — you can pick events, toggle attendance, type a dietary note and
// "send" — but the RSVP is a deliberate NO-OP: nothing leaves the browser. This
// mirrors the real guest flow closely enough to feel live while making clear it
// is a demonstration. The same no-op treatment is used for the organiser host
// preview in cire/invites.

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
    <div class="border-border bg-surface-raised mx-auto max-w-160 overflow-hidden rounded-lg border shadow-2xl">
      {/* An honest frame header — a plain label, not imitation browser chrome. */}
      <div class="border-border flex items-center justify-center border-b px-4 py-3">
        <span class="font-body text-text-muted text-ui-xs tracking-ui-widest uppercase">
          A live Cire invitation
        </span>
      </div>

      <div class="px-6 py-10 text-center md:px-10">
        <p class="font-body text-gold text-ui-xs tracking-ui-ultra mb-3 uppercase">
          Together with their families
        </p>
        <h3 class="font-display text-text leading-ui-none mb-2 text-[clamp(2rem,6vw,2.75rem)] font-light italic">
          Amara &amp; Sam
        </h3>
        <p class="font-body text-text-muted text-ui-base mb-8 font-light">
          request the pleasure of your company
        </p>

        <div class="flex flex-col gap-4 text-left">
          <For each={DEMO_EVENTS}>
            {(event) => (
              <article class="border-border bg-surface rounded-sm border px-5 py-5">
                <h4 class="font-display text-text mb-1 text-xl font-normal italic">{event.name}</h4>
                <p class="font-body text-gold text-ui-xs tracking-ui-wider mb-1 uppercase">
                  {event.date}
                </p>
                <p class="font-body text-text-muted text-ui-sm mb-2">{event.location}</p>
                <p class="font-body text-text-muted text-ui-sm leading-ui-normal mb-4 font-light">
                  {event.description}
                </p>
                <Button variant="cta" class="min-h-11" onClick={() => setRsvpEvent(event)}>
                  Respond
                </Button>
              </article>
            )}
          </For>
        </div>

        <p class="font-body text-text-muted text-ui-xs tracking-ui-wide mt-6">
          This is an interactive preview. Responses aren&rsquo;t saved.
        </p>
      </div>

      {/* No `<Show>`: `DemoModal` has to stay mounted to animate its exit, and
          `Modal` already mounts its own children only while it is open. The
          body's event comes through `heldWhileClosing` so it survives the
          fade. */}
      <DemoRsvpModal
        event={rsvpEvent()}
        members={DEMO_MEMBERS}
        onClose={() => setRsvpEvent(null)}
      />
    </div>
  );
}

interface DemoRsvpModalProps {
  /** `null` while closed, and still the last event while the sheet fades out. */
  event: DemoEvent | null;
  members: DemoMember[];
  onClose: () => void;
}

interface MemberState {
  attending: Attending;
  dietary: string;
  dietaryPresets: readonly DietaryPreset[];
}

function DemoRsvpModal(props: DemoRsvpModalProps) {
  // The body is built from the event, and closing sets it null — so without
  // this the sheet would fade out as an empty box.
  const shownEvent = heldWhileClosing(() => props.event);

  const eventMembers = createMemo(() =>
    props.members.filter((m) => m.eventIds.includes(shownEvent()?.id ?? "")),
  );

  const [responses, setResponses] = createSignal<Record<string, MemberState>>({});
  const [error, setError] = createSignal<string | null>(null);
  const [submitted, setSubmitted] = createSignal(false);
  const titleId = createUniqueId();

  /*
   * Reset per event, explicitly.
   *
   * This component used to be mounted inside `<Show when={rsvpEvent()}>`, so
   * every event got a fresh instance and its state reset by construction. It
   * stays mounted now — the sheet has to survive its own exit animation — which
   * means one instance for every event, and a `createSignal` initialiser that
   * runs once, while `props.event` is still null.
   *
   * The failure that caused was quiet rather than loud: `responses` stayed `{}`,
   * so `current[guestId]?.attending !== null` was `undefined !== null`, every
   * guest counted as answered, and the "respond for everyone" guard never
   * fired. A test caught it; nothing about the rendered sheet looked wrong.
   */
  createEffect(
    on(
      () => shownEvent()?.id,
      () => {
        setResponses(
          Object.fromEntries(
            eventMembers().map((m) => [
              m.guestId,
              { attending: null, dietary: "", dietaryPresets: [] } as MemberState,
            ]),
          ),
        );
        setError(null);
        setSubmitted(false);
      },
    ),
  );

  function setAttending(guestId: string, attending: Attending) {
    setResponses((prev) => ({ ...prev, [guestId]: { ...prev[guestId]!, attending } }));
  }
  function setDietaryPresets(guestId: string, dietaryPresets: readonly DietaryPreset[]) {
    setResponses((prev) => ({ ...prev, [guestId]: { ...prev[guestId]!, dietaryPresets } }));
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
    <DemoModal open={props.event !== null} onClose={props.onClose} labelledBy={titleId}>
      <Show
        when={!submitted()}
        fallback={
          <div class="py-6 text-center">
            <p class="font-body text-gold text-ui-xs tracking-ui-widest mb-3 uppercase">Preview</p>
            <h3 class="font-display text-text text-ui-xl mb-4 font-light italic">
              That&rsquo;s the feeling.
            </h3>
            <p class="font-body text-text-muted text-ui-base leading-ui-normal mb-7 font-light">
              On a real Cire invitation, your reply would be on its way to the couple and counted in
              their live guest dashboard. Here, nothing is saved. It&rsquo;s just a taste.
            </p>
            <Button variant="cta" size="lg" onClick={() => props.onClose()}>
              Close
            </Button>
          </div>
        }
      >
        <p class="font-body text-gold text-ui-xs tracking-ui-widest mb-3 uppercase">Respond</p>
        <h3 id={titleId} class="font-display text-text text-ui-xl mb-2 font-light italic">
          {shownEvent()?.name}
        </h3>
        <p
          class="border-gold/40 bg-gold/5 text-gold text-ui-xs mb-6 rounded-sm border px-3.5 py-2.5 leading-relaxed"
          role="status"
        >
          Interactive preview. Your reply won&rsquo;t be saved.
        </p>

        <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
          <For each={eventMembers()}>
            {(member) => {
              const guestId = member.guestId;
              return (
                <fieldset class="border-border m-0 rounded-sm border p-5">
                  <legend class="font-display text-text text-ui-md mb-3 font-normal italic">
                    {member.firstName} {member.lastName}
                  </legend>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="font-body text-ui-sm tracking-ui-wide flex-1 cursor-pointer rounded-sm border px-3 py-2.5 uppercase transition-colors duration-200"
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
                      class="font-body text-ui-sm tracking-ui-wide flex-1 cursor-pointer rounded-sm border px-3 py-2.5 uppercase transition-colors duration-200"
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
                    <div class="mt-3">
                      <DietaryPresets
                        value={responses()[guestId]?.dietaryPresets ?? []}
                        onChange={(next) => setDietaryPresets(guestId, next)}
                        label={`Dietary requirements for ${member.firstName}`}
                      />
                    </div>
                    <Show when={responses()[guestId]?.dietaryPresets.includes("other")}>
                      <label class="font-body text-text-muted text-ui-sm tracking-ui-wide mt-3 block uppercase">
                        Anything else
                        <input
                          type="text"
                          class="border-border font-body text-text placeholder:text-text-muted focus:border-gold sm:text-ui-base mt-1.5 block w-full rounded-sm border bg-transparent px-3 py-2.5 text-base transition-colors duration-200 focus:outline-none"
                          placeholder="e.g. no onion or garlic"
                          value={responses()[guestId]?.dietary ?? ""}
                          onInput={(e) => setDietary(guestId, e.currentTarget.value)}
                          maxLength={500}
                        />
                      </label>
                    </Show>
                  </Show>
                </fieldset>
              );
            }}
          </For>

          <Show when={error()}>
            <p class="font-body text-error text-ui-sm py-1" role="alert">
              {error()}
            </p>
          </Show>

          <div class="border-border bg-surface sticky bottom-0 -mx-6 -mb-[max(2.5rem,env(safe-area-inset-bottom))] flex gap-3 border-t px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:-mb-10 md:pb-4">
            <Button variant="quiet" class="flex-1" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button type="submit" variant="cta" class="flex-1">
              Send RSVP
            </Button>
          </div>
        </form>
      </Show>
    </DemoModal>
  );
}
