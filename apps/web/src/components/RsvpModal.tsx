import { createSignal, Show, For } from "solid-js"
import type { EventSummary } from "./types"
import { parseMembers } from "./utils"

interface RsvpModalProps {
  event: EventSummary
  guestName: string
  onClose: () => void
}

export function RsvpModal(props: RsvpModalProps) {
  const members = () => parseMembers(props.guestName)

  const [responses, setResponses] = createSignal<Record<string, {
    attending: boolean | null
    dietary: string
  }>>(
    Object.fromEntries(
      members().map((name) => [name, { attending: null, dietary: "" }]),
    ),
  )

  function setAttending(name: string, attending: boolean) {
    setResponses((prev) => ({
      ...prev,
      [name]: { ...prev[name], attending },
    }))
  }

  function setDietary(name: string, dietary: string) {
    setResponses((prev) => ({
      ...prev,
      [name]: { ...prev[name], dietary },
    }))
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    // TODO: POST to /api/rsvp when endpoint is ready
    props.onClose()
  }

  return (
    <div class="modal-backdrop" onClick={() => props.onClose()}>
      <div
        class="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button
          class="modal-close"
          onClick={() => props.onClose()}
          aria-label="Close"
        >
          &times;
        </button>
        <p class="section-eyebrow">Respond</p>
        <h3 class="modal-heading">{props.event.name}</h3>

        <form class="rsvp-form" onSubmit={handleSubmit}>
          <For each={members()}>
            {(name) => (
              <fieldset class="rsvp-member">
                <legend class="rsvp-member-name">{name}</legend>

                <div class="rsvp-attendance">
                  <button
                    type="button"
                    class="rsvp-toggle"
                    classList={{
                      active: responses()[name]?.attending === true,
                    }}
                    onClick={() => setAttending(name, true)}
                  >
                    Attending
                  </button>
                  <button
                    type="button"
                    class="rsvp-toggle"
                    classList={{
                      active: responses()[name]?.attending === false,
                    }}
                    onClick={() => setAttending(name, false)}
                  >
                    Not Attending
                  </button>
                </div>

                <Show when={responses()[name]?.attending === true}>
                  <label class="rsvp-dietary-label">
                    Dietary requirements
                    <input
                      type="text"
                      class="rsvp-dietary-input"
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

          <button type="submit" class="rsvp-submit">
            Save Response
          </button>
        </form>
      </div>
    </div>
  )
}
