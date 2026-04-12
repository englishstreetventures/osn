import { For, Show } from "solid-js"
import type { EventSummary, DressCodeInfo } from "./types"
import { EVENT_DRESS_CODES } from "./dress-codes"
import { AnimatedModal } from "./AnimatedModal"

interface DetailsModalProps {
  event: EventSummary
  onClose: () => void
}

export function DetailsModal(props: DetailsModalProps) {
  const dressCode = (): DressCodeInfo | undefined =>
    EVENT_DRESS_CODES[props.event.id]

  return (
    <AnimatedModal onClose={props.onClose}>
      <p class="mb-3 font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">
        Details
      </p>
      <h3 class="mb-6 font-display text-[1.6rem] font-light italic text-text">
        {props.event.name}
      </h3>

      <Show
        when={dressCode()}
        fallback={
          <p class="font-body text-[0.92rem] italic text-text-muted">
            Dress code details will be added soon.
          </p>
        }
      >
        {(dc) => (
          <div class="text-center">
            <h4 class="mb-3 font-body text-[0.72rem] font-normal uppercase tracking-[0.2em] text-gold">
              Dress Code
            </h4>
            <p class="mb-6 font-body text-[0.92rem] font-light leading-[1.65] text-text-muted">
              {dc().description}
            </p>

            <div class="mb-6 flex flex-wrap justify-center gap-5">
              <For each={dc().palette}>
                {(c) => (
                  <div class="flex flex-col items-center gap-2">
                    <div
                      class="h-12 w-12 rounded-full border border-border"
                      style={{ "background-color": c.hex }}
                    />
                    <span class="font-body text-[0.72rem] uppercase tracking-[0.08em] text-text-muted">
                      {c.name}
                    </span>
                  </div>
                )}
              </For>
            </div>

            <div class="rounded-sm border border-dashed border-border p-6">
              <p class="font-body text-[0.85rem] italic text-text-muted">
                Pinterest inspiration board coming soon.
              </p>
            </div>
          </div>
        )}
      </Show>
    </AnimatedModal>
  )
}
