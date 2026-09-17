import {
  DIETARY_PRESET_BAND,
  DIETARY_PRESET_LABEL,
  DIETARY_PRESETS,
  type DietaryBand,
  type DietaryPreset,
} from "@cire/dietary";
import { createMemo, For, Show, type JSX } from "solid-js";

/**
 * The dietary-requirement picker, inline: every option visible, nothing to open.
 *
 * Every surface that collects dietary requirements renders this or the popover
 * that wraps it, so the vocabulary a caterer eventually reads is decided in
 * exactly one place.
 *
 * On a phone this is the whole control — answering is a tap, and something you
 * must open first is a tap spent before you can start. The checkboxes sit in a
 * horizontally scrolling track.
 *
 * ## Why this file imports no popover
 *
 * `@cire/ui/dietary-presets-popover` is a separate entry point, and the split is
 * a bundle boundary rather than a tidying. A static top-level import is what a
 * bundler follows, so a single component that *could* be either shell shipped
 * Kobalte to the guest invite — which renders the inline shell only — and put
 * that app 8 KB gzip over its size guard. A `<Show>` around the JSX does not
 * help: the cost is the import, not the render.
 *
 * ## Why the trigger is not a `<select>`
 *
 * A native select cannot express "vegetarian AND no nuts", and that is the
 * common case rather than the edge — a guest with two requirements would have to
 * abandon the list and type both into "Other", which is the failure the presets
 * exist to remove.
 *
 * ## A `<fieldset>` with no `<legend>`
 *
 * The grouping is a real fieldset, named by `aria-label` rather than a legend.
 * A caller already wraps this in a fieldset whose legend says whose
 * requirements these are, and on a household sheet that name is load-bearing —
 * "Vegetarian" means nothing without "for Ravi". A second legend inside it
 * pushes screen readers to announce only the innermost, dropping the member's
 * name from every checkbox; an `aria-label` names this group without competing.
 * The band headings are plain text for the same reason.
 *
 * ## The "Other" box is the caller's
 *
 * This renders the presets and nothing else. The free-text box belongs to the
 * form, below this control, because it has to stay reachable while a popover
 * shell is closed — and a guest who has typed something must be able to see it
 * without reopening anything.
 */

const BAND_LABEL = {
  diet: "Diet",
  allergy: "Allergies",
  other: "",
} satisfies Readonly<Record<DietaryBand, string>>;

/** The order bands render in; `other` trails both and gets no heading. */
const BANDS = ["diet", "allergy", "other"] as const;

export interface DietaryPresetsProps {
  /** The current selection. Controlled — this component holds no state. */
  value: readonly DietaryPreset[];
  onChange: (next: readonly DietaryPreset[]) => void;
  /** Disables every checkbox and the trigger: submitting, saved, or past the
   *  RSVP deadline. */
  disabled?: boolean;
  /** Names whose requirements these are, for the group's accessible name. */
  label?: string;
  /** Wrap the pills into a column instead of a scrolling row. The popover shell
   *  sets it; inline callers leave it off. */
  wrap?: boolean;
}

function toggle(
  current: readonly DietaryPreset[],
  key: DietaryPreset,
  on: boolean,
): readonly DietaryPreset[] {
  const next = new Set(current);
  if (on) next.add(key);
  else next.delete(key);
  // Canonical order, so the value this hands back is the order it renders and
  // the order the column stores. Nothing downstream has to re-sort.
  return DIETARY_PRESETS.filter((k) => next.has(k));
}

function PresetCheckbox(props: {
  preset: DietaryPreset;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <label class="font-body border-ui-hairline text-ui-ink has-[:checked]:border-ui-accent has-[:checked]:bg-ui-accent-wash has-[:focus-visible]:ring-ui-focus flex shrink-0 cursor-pointer snap-start items-center gap-2 rounded-full border px-3 py-1.5 text-[0.82rem] whitespace-nowrap transition-colors duration-200 select-none has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2">
      {/* A real checkbox, visually hidden rather than replaced: the checked
          state, the space key, the screen-reader announcement and the label
          association all come from the platform. `sr-only` keeps it focusable,
          which `display: none` would not. */}
      <input
        type="checkbox"
        class="sr-only"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span aria-hidden="true" class="text-ui-accent text-[0.9em] leading-none">
        {props.checked ? "✓" : "+"}
      </span>
      {DIETARY_PRESET_LABEL[props.preset]}
    </label>
  );
}

/**
 * The bands, grouped once at module load.
 *
 * Reads only module constants, so a `createMemo` per instance computed the same
 * three groups again for every mounted picker and could never recompute — and a
 * household sheet mounts one per attending member.
 */
export const BANDED_PRESETS = BANDS.map((band) => ({
  band,
  presets: DIETARY_PRESETS.filter((k) => DIETARY_PRESET_BAND[k] === band),
}));

export default function DietaryPresets(props: DietaryPresetsProps): JSX.Element {
  const selected = createMemo(() => new Set(props.value));

  /**
   * `wrap` is the caller's, not a media query's.
   *
   * Inline on a phone the track scrolls sideways; inside a popover panel the
   * same fields wrap into a column. The shell already knows which it is, so
   * asking a second time here would be a redundant answer — and it is what let
   * this component reach for a popover it did not always render.
   */
  return (
    <fieldset
      aria-label={props.label ?? "Dietary requirements"}
      // A fieldset carries a border, padding and margin by default; this is a
      // grouping for semantics, not a box. `min-w-0` is load-bearing: a
      // `<fieldset>` resolves its min-width from its CONTENT, so without it the
      // scrolling track below cannot shrink and the sixteen pills push the whole
      // sheet wider than the phone instead of overflowing inside it.
      class="m-0 block min-w-0 border-0 p-0"
    >
      <div
        classList={{
          "flex min-w-0 gap-4": true,
          "snap-x snap-proximity overflow-x-auto pb-1": !props.wrap,
          "flex-col gap-3": props.wrap,
        }}
      >
        <For each={BANDED_PRESETS}>
          {(group) => (
            <div
              classList={{
                "flex gap-2": true,
                "shrink-0 items-center": !props.wrap,
                "flex-col items-start": props.wrap,
              }}
            >
              <Show when={BAND_LABEL[group.band] !== ""}>
                <p class="font-body text-ui-ink-muted shrink-0 text-[0.68rem] tracking-[0.12em] uppercase">
                  {BAND_LABEL[group.band]}
                </p>
              </Show>
              <div
                classList={{ "flex gap-2": true, "shrink-0": !props.wrap, "flex-wrap": props.wrap }}
              >
                <For each={group.presets}>
                  {(preset) => (
                    <PresetCheckbox
                      preset={preset}
                      checked={selected().has(preset)}
                      disabled={props.disabled}
                      onChange={(on) => props.onChange(toggle(props.value, preset, on))}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </fieldset>
  );
}
