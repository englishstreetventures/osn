import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { For, Show } from "solid-js";

import type { WeddingSummary } from "./CreateWeddingForm";

/**
 * The top bar's wedding context — which wedding is open, and the way to any
 * other one.
 *
 * The old chrome answered this with a full-width header band under a masthead
 * under a portal nav: three stacked rows before the first piece of content.
 * This is the same information as one control. The name is the trigger, so the
 * thing you read to know where you are is also the thing you press to leave.
 *
 * A menu rather than a `<select>`: each entry carries its slug as a second
 * line, and the list ends with a way back to the list view, neither of which an
 * option element can hold.
 */
export default function WeddingSwitcher(props: {
  current: WeddingSummary;
  weddings: WeddingSummary[];
  onSelect: (wedding: WeddingSummary) => void;
  onAll: () => void;
}) {
  // Only the *other* weddings need listing — the current one is already named
  // on the trigger, and offering it as a destination is a no-op row.
  const others = () => props.weddings.filter((w) => w.id !== props.current.id);

  return (
    <DropdownMenu placement="bottom-start" gutter={8}>
      <DropdownMenu.Trigger
        aria-label="Switch wedding"
        class="group hover:bg-surface/60 flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 transition-colors duration-(--dur-fast) ease-(--ease-out)"
      >
        <span class="font-display text-text min-w-0 truncate text-[1.02rem] leading-none font-light">
          {props.current.displayName}
        </span>
        <span
          aria-hidden="true"
          class="text-text-faint group-hover:text-gold shrink-0 text-[0.6rem] transition-colors duration-(--dur-fast)"
        >
          ▾
        </span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content class="border-border bg-surface z-50 max-h-[min(24rem,70vh)] min-w-64 overflow-y-auto rounded-sm border p-1.5 shadow-(--elev-2) outline-none">
          <Show when={others().length > 0}>
            <p class="font-body text-text-faint px-3 pt-1.5 pb-2 text-[0.62rem] tracking-[0.18em] uppercase">
              Switch to
            </p>
            <For each={others()}>
              {(wedding) => (
                <DropdownMenu.Item
                  class="font-body data-[highlighted]:bg-gold/10 flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-sm px-3 py-2 transition-colors duration-(--dur-fast) outline-none"
                  onSelect={() => props.onSelect(wedding)}
                >
                  <span class="text-text w-full truncate text-[0.85rem]">
                    {wedding.displayName}
                  </span>
                  <span class="text-text-muted w-full truncate text-[0.68rem] tracking-[0.14em] uppercase">
                    {wedding.slug}
                  </span>
                </DropdownMenu.Item>
              )}
            </For>
            <DropdownMenu.Separator class="bg-border/60 mx-1 my-1.5 h-px border-0" />
          </Show>

          <DropdownMenu.Item
            class="font-body text-text-muted data-[highlighted]:bg-gold/10 data-[highlighted]:text-gold flex w-full cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-[0.74rem] tracking-[0.12em] uppercase transition-colors duration-(--dur-fast) outline-none"
            onSelect={() => props.onAll()}
          >
            <span aria-hidden="true">←</span>
            All weddings
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}
