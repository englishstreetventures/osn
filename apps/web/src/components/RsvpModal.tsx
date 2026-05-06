import { createMemo, createSignal, onCleanup, Show, For } from "solid-js";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";
import { AnimatedModal } from "./AnimatedModal";

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
      <p class="mb-3 font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">Respond</p>
      <h3 class="mb-6 font-display text-[1.6rem] font-light italic text-text">
        {props.event.name}
      </h3>

      <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
        <For each={eventMembers()}>
          {(member) => {
            const guestId = member.guestId;
            return (
              <fieldset class="rounded-sm border border-border p-5 m-0">
                <legend class="font-display text-[1.1rem] font-normal italic text-text mb-3">
                  {member.firstName} {member.lastName}
                </legend>

                <div class="flex gap-2">
                  <button
                    type="button"
                    class="flex-1 rounded-sm border px-3 py-2.5 font-body text-[0.82rem] uppercase tracking-[0.06em] transition-colors duration-200 cursor-pointer"
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
                    class="flex-1 rounded-sm border px-3 py-2.5 font-body text-[0.82rem] uppercase tracking-[0.06em] transition-colors duration-200 cursor-pointer"
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
                  <label class="mt-3 block font-body text-[0.78rem] uppercase tracking-[0.06em] text-text-muted">
                    Dietary requirements
                    <input
                      type="text"
                      class="mt-1.5 block w-full rounded-sm border border-border bg-transparent px-3 py-2.5 font-body text-[0.9rem] text-text transition-colors duration-200 placeholder:text-text-muted focus:border-gold focus:outline-none"
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
          <p class="font-body text-[0.82rem] text-error py-1" role="alert">
            {error()}
          </p>
        </Show>

        <div class="sticky bottom-0 -mx-6 -mb-10 flex gap-3 border-t border-border bg-surface px-6 py-4">
          <button
            type="button"
            class="flex-1 rounded-sm border border-border bg-transparent px-4 py-3 font-body text-[0.82rem] uppercase tracking-[0.1em] text-text-muted transition-colors duration-200 hover:border-gold-dim hover:text-text cursor-pointer disabled:opacity-40"
            onClick={() => props.onClose()}
            disabled={loading()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="flex-1 rounded-sm border border-gold bg-transparent px-4 py-3 font-body text-[0.82rem] uppercase tracking-[0.1em] text-gold transition-colors duration-200 hover:bg-gold hover:text-bg cursor-pointer disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gold"
            disabled={loading()}
          >
            {loading() ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </AnimatedModal>
  );
}
