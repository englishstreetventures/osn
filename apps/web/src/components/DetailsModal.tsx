import { For, Show } from "solid-js"
import type { EventSummary, DressCodeInfo } from "./types"
import { EVENT_DRESS_CODES } from "./dress-codes"

interface DetailsModalProps {
  event: EventSummary
  onClose: () => void
}

export function DetailsModal(props: DetailsModalProps) {
  const dressCode = (): DressCodeInfo | undefined =>
    EVENT_DRESS_CODES[props.event.id]

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
        <p class="section-eyebrow">Details</p>
        <h3 class="modal-heading">{props.event.name}</h3>

        <Show
          when={dressCode()}
          fallback={
            <p class="details-empty">Dress code details will be added soon.</p>
          }
        >
          {(dc) => (
            <div class="details-dress-code">
              <h4 class="details-label">Dress Code</h4>
              <p class="details-description">{dc().description}</p>

              <div class="colour-palette">
                <For each={dc().palette}>
                  {(c) => (
                    <div class="colour-swatch">
                      <div
                        class="swatch-circle"
                        style={{ "background-color": c.hex }}
                      />
                      <span class="swatch-label">{c.name}</span>
                    </div>
                  )}
                </For>
              </div>

              <div class="pinterest-placeholder">
                <p class="pinterest-note">
                  Pinterest inspiration board coming soon.
                </p>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
