import { For, Show } from "solid-js";

import { AnimatedModal } from "./AnimatedModal";
import { isValidColor, truncateSwatchName } from "./dress-code-render";
import { PinterestBoard } from "./PinterestBoard";
import type { EventSummary } from "./types";

interface DetailsModalProps {
  event: EventSummary;
  onClose: () => void;
}

export function DetailsModal(props: DetailsModalProps) {
  return (
    <AnimatedModal onClose={props.onClose}>
      <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">Details</p>
      <h3 class="font-display text-text mb-6 text-[1.6rem] font-light italic">
        {props.event.name}
      </h3>

      <Show
        when={props.event.dressCodeDescription || props.event.dressCodePalette}
        fallback={
          <p class="font-body text-text-muted text-[0.92rem] italic">
            Dress code details coming soon.
          </p>
        }
      >
        <div class="text-center">
          <h4 class="font-body text-gold mb-3 text-[0.72rem] font-normal tracking-[0.2em] uppercase">
            Dress Code
          </h4>

          <Show when={props.event.dressCodeDescription}>
            {(desc) => (
              <p class="font-body text-text-muted mb-6 text-[0.92rem] leading-[1.65] font-light">
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
                          class="border-border h-12 w-12 rounded-full border"
                          style={{ "background-color": swatch.color }}
                          aria-label={`${truncateSwatchName(swatch.name)} swatch`}
                        />
                        <span class="font-body text-text-muted text-[0.72rem] tracking-[0.08em] uppercase">
                          {truncateSwatchName(swatch.name)}
                        </span>
                      </div>
                    </Show>
                  )}
                </For>
              </div>
            )}
          </Show>

          <div class="border-border rounded-sm border border-dashed p-6">
            <h4 class="font-body text-gold mb-3 text-[0.72rem] font-normal tracking-[0.2em] uppercase">
              Inspiration
            </h4>
            <Show
              when={props.event.pinterestUrl}
              fallback={
                <p class="font-body text-text-muted text-[0.85rem] italic">
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
