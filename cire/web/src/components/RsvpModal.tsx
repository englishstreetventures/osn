import { createMemo, createSignal, onCleanup, Show, For } from "solid-js";

import { AnimatedModal } from "./AnimatedModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

interface RsvpModalProps {
  event: EventSummary;
  members: ReadonlyArray<FamilyMember>;
  existingRsvps?: ReadonlyArray<RsvpSummary>;
  apiUrl: string;
  onClose: () => void;
  onSubmitted?: (updated: RsvpSummary[]) => void;
}

type Attending = "attending" | "declined" | null;

interface MemberState {
  attending: Attending;
  dietary: string;
}

export function RsvpModal(props: RsvpModalProps) {
  const eventMembers = createMemo(() =>
    props.members.filter((m) => m.eventIds.includes(props.event.id)),
  );

  function initialResponses(): Record<string, MemberState> {
    const map: Record<string, MemberState> = {};
    const prior = props.existingRsvps ?? [];
    for (const m of eventMembers()) {
      const existing = prior.find((r) => r.guestId === m.guestId && r.eventId === props.event.id);
      let attending: Attending = null;
      if (existing) {
        if (existing.status === "attending") attending = "attending";
        else if (existing.status === "declined") attending = "declined";
        // "maybe" → null (UX is binary now)
      }
      map[m.guestId] = {
        attending,
        dietary: existing?.dietary ?? "",
      };
    }
    return map;
  }

  const [responses, setResponses] = createSignal<Record<string, MemberState>>(initialResponses());
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  // Abort the in-flight submit if the modal unmounts mid-request — keeps the
  // setError / setLoading writes from landing on a disposed instance.
  let inFlight: AbortController | null = null;
  onCleanup(() => inFlight?.abort());

  function setAttending(guestId: string, attending: Attending) {
    setResponses((prev) => ({
      ...prev,
      [guestId]: { ...prev[guestId]!, attending },
    }));
  }

  function setDietary(guestId: string, dietary: string) {
    setResponses((prev) => ({
      ...prev,
      [guestId]: { ...prev[guestId]!, dietary },
    }));
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    setError(null);

    const current = responses();
    const visible = eventMembers();
    const allAnswered = visible.every((m) => current[m.guestId]?.attending !== null);
    if (!allAnswered) {
      setError("Please respond for everyone in your party.");
      return;
    }

    setLoading(true);

    const body = {
      rsvps: visible.map((m) => {
        const state = current[m.guestId]!;
        return {
          guestId: m.guestId,
          eventId: props.event.id,
          status: state.attending!,
          dietary: state.attending === "attending" ? state.dietary : "",
        };
      }),
    };

    inFlight = new AbortController();
    try {
      const res = await fetch(`${props.apiUrl}/api/rsvp`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: inFlight.signal,
      });

      if (res.status === 200) {
        const data = (await res.json()) as { rsvps: RsvpSummary[] };
        // Solid signal writes are synchronous, so the order here is safe even
        // if the parent unmounts the modal on `onClose`.
        props.onSubmitted?.(data.rsvps);
        props.onClose();
        return;
      }

      if (res.status === 401) {
        setError("Your session expired. Please re-enter your code.");
      } else if (res.status === 403) {
        setError("You're not authorised to RSVP for one of those guests.");
      } else if (res.status === 429) {
        setError("Too many requests. Please try again in a moment.");
      } else {
        setError("Something went wrong. Please try again.");
      }
      setLoading(false);
    } catch (err) {
      // Abort-on-unmount is silent; only surface real network failures.
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setError("Could not connect. Please check your connection.");
      setLoading(false);
    } finally {
      inFlight = null;
    }
  }

  return (
    <AnimatedModal onClose={props.onClose}>
      <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">Respond</p>
      <h3 class="font-display text-text mb-6 text-[1.6rem] font-light italic">
        {props.event.name}
      </h3>

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
                    disabled={loading()}
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
                    disabled={loading()}
                  >
                    Not attending
                  </button>
                </div>

                <Show when={responses()[guestId]?.attending === "attending"}>
                  <label class="font-body text-text-muted mt-3 block text-[0.78rem] tracking-[0.06em] uppercase">
                    Dietary requirements
                    <input
                      type="text"
                      class="border-border font-body text-text placeholder:text-text-muted focus:border-gold mt-1.5 block w-full rounded-sm border bg-transparent px-3 py-2.5 text-[0.9rem] transition-colors duration-200 focus:outline-none"
                      placeholder="e.g. Vegetarian, no nuts"
                      value={responses()[guestId]?.dietary ?? ""}
                      onInput={(e) => setDietary(guestId, e.currentTarget.value)}
                      maxLength={200}
                      disabled={loading()}
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

        <div class="border-border bg-surface sticky bottom-0 -mx-6 -mb-10 flex gap-3 border-t px-6 py-4">
          <button
            type="button"
            class="border-border font-body text-text-muted hover:border-gold-dim hover:text-text flex-1 cursor-pointer rounded-sm border bg-transparent px-4 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200 disabled:opacity-40"
            onClick={() => props.onClose()}
            disabled={loading()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="border-gold font-body text-gold hover:bg-gold hover:text-bg disabled:hover:text-gold flex-1 cursor-pointer rounded-sm border bg-transparent px-4 py-3 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={loading()}
          >
            {loading() ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </AnimatedModal>
  );
}
