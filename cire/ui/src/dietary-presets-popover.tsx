import { DIETARY_PRESET_LABEL, type DietaryPreset } from "@cire/dietary";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import DietaryPresets, { type DietaryPresetsProps } from "./dietary-presets";

/*
 * The dietary picker, collapsed behind a trigger above a breakpoint.
 *
 * Sixteen pills across a desktop form is a wall, so past `md:` the same fields
 * move into a popover behind a button that names the current selection. Below
 * it this renders the inline picker unchanged — a control you must open first
 * is a tap spent before you can start, and on a phone answering should be a tap.
 *
 * ## Why this is a separate entry point
 *
 * A bundle boundary, not a tidying. Kobalte's popover is ~18.7 KB gzip, and a
 * static top-level import is what a bundler follows — so one component that
 * *could* be either shell shipped all of it to the guest invite, which renders
 * the inline shell only, and put that app over its size guard. A `<Show>` around
 * the JSX does not help: the cost is the import, not the render. Importing
 * `@cire/ui/dietary-presets` gets the fields and no popover; importing this gets
 * both, and only the callers that open one pay for it.
 *
 * ## Not usable inside every modal
 *
 * `Modal` is `<dialog>` + `showModal()`, so it paints in the top layer.
 * `@shared/ui`'s popover mounts its panel into the open dialog to clear that,
 * which works — except in a `frame` Modal, whose dialog is `overflow-hidden` and
 * therefore clips the panel. A caller inside one wants
 * `@cire/ui/dietary-presets` directly until xchromo/osn#1089 lands.
 */

/** Matches the `md:` breakpoint the rest of cire's invite sheet forks at. */
const WIDE_QUERY = "(min-width: 48rem)";

/**
 * Track the breakpoint for this instance.
 *
 * Guarded, and falls back to the inline shell where `matchMedia` is absent —
 * jsdom, a server render — rather than throwing at mount, because every
 * consumer's unit suite mounts this through a form.
 *
 * The `change` listener is not optional: a signal seeded from `.matches` alone
 * never updates, so a window resized across the breakpoint would strand a guest
 * with a trigger that opens nothing.
 *
 * One subscription per mounted picker, and a household sheet mounts one per
 * attending member — so a resize across the breakpoint runs one handler per
 * member rather than one per page. They all watch the same query, so a shared
 * page-level signal would do; a module-level singleton was tried and rejected
 * because it caches the first viewport a process ever sees, which is wrong in
 * any environment that outlives one page.
 */
function createIsWide() {
  const [wide, setWide] = createSignal(false);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return wide;
  const query = window.matchMedia(WIDE_QUERY);
  setWide(query.matches);
  const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
  query.addEventListener("change", onChange);
  onCleanup(() => query.removeEventListener("change", onChange));
  return wide;
}

/**
 * What the collapsed trigger says.
 *
 * The selection itself, never a static "Dietary requirements" — a closed control
 * that does not say what it holds makes a guest open it to check, every time.
 * Truncated at two so a long selection cannot outgrow the button.
 */
function summarise(value: readonly DietaryPreset[]): string {
  if (value.length === 0) return "Add dietary requirements";
  const shown = value.slice(0, 2).map((k) => DIETARY_PRESET_LABEL[k]);
  const rest = value.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

export default function DietaryPresetsPopover(props: DietaryPresetsProps): JSX.Element {
  const wide = createIsWide();

  return (
    <Show when={wide()} fallback={<DietaryPresets {...props} />}>
      <Popover gutter={6} placement="bottom-start">
        <PopoverTrigger
          disabled={props.disabled}
          class="font-body border-ui-hairline text-ui-ink hover:border-ui-accent-soft focus-visible:ring-ui-focus rounded-ui-sm flex w-full cursor-pointer items-center justify-between gap-2 border bg-transparent px-3 py-2.5 text-left text-[0.88rem] transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span classList={{ "text-ui-ink-muted": props.value.length === 0 }}>
            {summarise(props.value)}
          </span>
          <span aria-hidden="true" class="text-ui-ink-muted text-[0.7em]">
            ▾
          </span>
        </PopoverTrigger>
        <PopoverContent class="base:w-auto base:max-w-[22rem] base:p-4">
          <DietaryPresets {...props} wrap />
        </PopoverContent>
      </Popover>
    </Show>
  );
}
