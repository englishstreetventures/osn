import { presetLabels, type DietaryPreset } from "@cire/dietary";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import Button from "./button";
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
 * which works — except in a `frame` Modal, whose dialog is `overflow-clip` and
 * therefore clips the panel. A caller inside one wants
 * `@cire/ui/dietary-presets` directly until englishstventures/osn#1089 lands.
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
 *
 * Built from `presetLabels`, the same labels in the same order as the
 * organiser's table cell, so a key this build does not know reads as words
 * rather than a blank, and one row never reads in two orders on one screen.
 */
function summarise(value: readonly string[]): string {
  const labels = presetLabels(value);
  if (labels.length === 0) return "Add dietary requirements";
  const shown = labels.slice(0, 2);
  const rest = labels.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

export default function DietaryPresetsPopover<K extends string = DietaryPreset>(
  props: DietaryPresetsProps<K>,
): JSX.Element {
  const wide = createIsWide();

  return (
    <Show when={wide()} fallback={<DietaryPresets {...props} />}>
      <Popover gutter={6} placement="bottom-start">
        {/* `as={Button}`, so the trigger's border, padding, type and focus ring
            are the `field` variant's rather than a class list here — the one
            shape in cire's button set that reads as a form control instead of
            an action, which is what this is: it stands where the free-text box
            below it stands, and holds a value rather than a verb.

            `justify-between` and the width are placement, and stay: the caret
            belongs at the far edge whatever the summary's length. */}
        <PopoverTrigger
          as={Button}
          variant="field"
          disabled={props.disabled}
          class="w-full justify-between text-left"
        >
          <span classList={{ "text-ui-ink-muted": props.value.length === 0 }}>
            {summarise(props.value)}
          </span>
          <span aria-hidden="true" class="text-ui-ink-muted text-ui-xs">
            ▾
          </span>
        </PopoverTrigger>
        {/* `padding="none"` and a plain wrapper, rather than the panel's own
            inset: a wrapped grid of sixteen pills wants more room than the
            popover's default, and the room a caller wants is the caller's to
            put in a box of its own. */}
        <PopoverContent padding="none" class="w-auto max-w-xs">
          <div class="p-4">
            <DietaryPresets {...props} wrap />
          </div>
        </PopoverContent>
      </Popover>
    </Show>
  );
}
