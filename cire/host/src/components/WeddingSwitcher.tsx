import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { For, type JSX, Show } from "solid-js";

import type { WeddingSummary } from "./CreateWeddingForm";

/** The wedding's name the menu opens from: a control with its own look, which
 *  the menu's trigger renders as (`as`), as it would a `Button`. */
function NameButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      class="group hover:bg-surface/60 transition-ui-colors flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 duration-(--dur-fast) ease-(--ease-out)"
    />
  );
}

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
 * option element can hold. The shared menu's accent look, as every portal
 * menu draws it, under a muted "Switch to" eyebrow.
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
      <DropdownMenuTrigger as={NameButton} aria-label="Switch wedding">
        {/* `truncate` clips at this box, and at this size Cormorant's g, j, p
            and y reach about 4.7px below the baseline, past the 3.7px a 1.1
            line leaves. The name keeps 2px of padding inside the clip, taken
            from the trigger's own. */}
        <span class="font-display text-text text-ui-md leading-ui-none min-w-0 truncate py-0.5 font-light">
          {props.current.displayName}
        </span>
        <span
          aria-hidden="true"
          class="text-text-faint group-hover:text-gold text-ui-xs transition-ui-colors shrink-0 duration-(--dur-fast) ease-(--ease-out)"
        >
          ▾
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        variant="accent"
        class="max-h-[min(24rem,70vh)] min-w-64 overflow-y-auto"
      >
        <Show when={others().length > 0}>
          <DropdownMenuGroup>
            <DropdownMenuLabel tone="eyebrow">Switch to</DropdownMenuLabel>
            <For each={others()}>
              {(wedding) => (
                <DropdownMenuItem onSelect={() => props.onSelect(wedding)}>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate">{wedding.displayName}</span>
                    <span class="text-text-muted text-ui-xs tracking-ui-widest truncate uppercase">
                      {wedding.slug}
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
        </Show>

        <DropdownMenuItem onSelect={() => props.onAll()}>
          <span class="flex items-center gap-2">
            <span aria-hidden="true">←</span>
            All weddings
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
