import { For, Show } from "solid-js";
import type { EventSummary } from "./types";
import { isValidColor, truncateSwatchName } from "./dress-code-render";
import { AnimatedModal } from "./AnimatedModal";
import { PinterestBoard } from "./PinterestBoard";

interface DetailsModalProps {
  event: EventSummary;
  onClose: () => void;
}

export function DetailsModal(props: DetailsModalProps) {
  return (
    <AnimatedModal onClose={props.onClose}>
      <p class="mb-3 font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">Details</p>
      <h3 class="mb-6 font-display text-[1.6rem] font-light italic text-text">
        {props.event.name}
      </h3>

      <Show
        when={props.event.dressCodeDescription || props.event.dressCodePalette}
        fallback={
          <p class="font-body text-[0.92rem] italic text-text-muted">
            Dress code details coming soon.
          </p>
        }
      >
        <div class="text-center">
          <h4 class="mb-3 font-body text-[0.72rem] font-normal uppercase tracking-[0.2em] text-gold">
            Dress Code
          </h4>

          <Show when={props.event.dressCodeDescription}>
            {(desc) => (
              <p class="mb-6 font-body text-[0.92rem] font-light leading-[1.65] text-text-muted">
                {desc()}
              </p>
            )}
          </Show>

          <Show when={props.event.dressCodePalette}>
            {(palette) => (
              <div class="mb-6 flex flex-wrap justify-center gap-5">
                <For each={palette()}>
                  {(swatch) => (
                    <Show when={isValidColor(swatch.color)}>
                      <div class="flex flex-col items-center gap-2">
                        <div
                          class="h-12 w-12 rounded-full border border-border"
                          style={{ "background-color": swatch.color }}
                          aria-label={`${truncateSwatchName(swatch.name)} swatch`}
                        />
                        <span class="font-body text-[0.72rem] uppercase tracking-[0.08em] text-text-muted">
                          {truncateSwatchName(swatch.name)}
                        </span>
                      </div>
                    </Show>
                  )}
                </For>
              </div>
            )}
          </Show>

          <div class="rounded-sm border border-dashed border-border p-6">
            <h4 class="mb-3 font-body text-[0.72rem] font-normal uppercase tracking-[0.2em] text-gold">
              Inspiration
            </h4>
            <Show
              when={props.event.pinterestUrl}
              fallback={
                <p class="font-body text-[0.85rem] italic text-text-muted">
                  No inspiration board yet.
                </p>
              }
            >
              {(url) => <PinterestBoard url={url()} eventName={props.event.name} />}
            </Show>
          </div>
        </div>
      </Show>
    </AnimatedModal>
  );
}
