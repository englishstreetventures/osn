import { createSignal, Show, For } from "solid-js";
import type { EventSummary } from "./types";
import { parseMembers } from "./utils";
import { AnimatedModal } from "./AnimatedModal";

interface RsvpModalProps {
  event: EventSummary;
  guestName: string;
  onClose: () => void;
}

export function RsvpModal(props: RsvpModalProps) {
  const members = () => parseMembers(props.guestName);

  const [responses, setResponses] = createSignal<
    Record<
      string,
      {
        attending: boolean | null;
        dietary: string;
      }
    >
  >(Object.fromEntries(members().map((name) => [name, { attending: null, dietary: "" }])));

  function setAttending(name: string, attending: boolean) {
    setResponses((prev) => ({
      ...prev,
      [name]: { ...prev[name], attending },
    }));
  }

  function setDietary(name: string, dietary: string) {
    setResponses((prev) => ({
      ...prev,
      [name]: { ...prev[name], dietary },
    }));
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    // TODO: POST to /api/rsvp when endpoint is ready
    props.onClose();
  }

  return (
    <AnimatedModal onClose={props.onClose}>
      <p class="mb-3 font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">Respond</p>
      <h3 class="mb-6 font-display text-[1.6rem] font-light italic text-text">
        {props.event.name}
      </h3>

      <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
        <For each={members()}>
          {(name) => (
            <fieldset class="rounded-sm border border-border p-5 m-0">
              <legend class="font-display text-[1.1rem] font-normal italic text-text mb-3">
                {name}
              </legend>

              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-sm border px-3 py-2.5 font-body text-[0.82rem] uppercase tracking-[0.06em] transition-colors duration-200 cursor-pointer"
                  classList={{
                    "border-gold text-gold bg-gold/8": responses()[name]?.attending === true,
                    "border-border text-text-muted hover:border-gold-dim hover:text-text":
                      responses()[name]?.attending !== true,
                  }}
                  onClick={() => setAttending(name, true)}
                >
                  Attending
                </button>
                <button
                  type="button"
                  class="flex-1 rounded-sm border px-3 py-2.5 font-body text-[0.82rem] uppercase tracking-[0.06em] transition-colors duration-200 cursor-pointer"
                  classList={{
                    "border-gold text-gold bg-gold/8": responses()[name]?.attending === false,
                    "border-border text-text-muted hover:border-gold-dim hover:text-text":
                      responses()[name]?.attending !== false,
                  }}
                  onClick={() => setAttending(name, false)}
                >
                  Not Attending
                </button>
              </div>

              <Show when={responses()[name]?.attending === true}>
                <label class="mt-3 block font-body text-[0.78rem] uppercase tracking-[0.06em] text-text-muted">
                  Dietary requirements
                  <input
                    type="text"
                    class="mt-1.5 block w-full rounded-sm border border-border bg-transparent px-3 py-2.5 font-body text-[0.9rem] text-text transition-colors duration-200 placeholder:text-text-muted focus:border-gold focus:outline-none"
                    placeholder="e.g. Vegetarian, no nuts"
                    value={responses()[name]?.dietary ?? ""}
                    onInput={(e) => setDietary(name, e.currentTarget.value)}
                    maxLength={200}
                  />
                </label>
              </Show>
            </fieldset>
          )}
        </For>

        <button
          type="submit"
          class="mt-2 rounded-sm border border-gold bg-transparent px-6 py-3.5 font-body text-[0.88rem] uppercase tracking-[0.12em] text-gold transition-colors duration-200 hover:bg-gold hover:text-bg cursor-pointer"
        >
          Save Response
        </button>
      </form>
    </AnimatedModal>
  );
}
