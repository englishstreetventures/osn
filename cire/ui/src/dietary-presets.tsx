import {
  DIETARY_PRESET_BAND,
  DIETARY_PRESETS,
  isDietaryPreset,
  presetLabel,
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

/**
 * `K` is what the caller's selection may hold. A caller that has proven every
 * key against the vocabulary leaves it at `DietaryPreset`; the guest sheet and
 * the organiser's editor pass `string`, because a response may carry a key the
 * server knows and this build does not (the vocabulary grows server-first).
 * Such a key gets a checked pill labelled by `presetLabel`, after every known
 * one, so whoever is answering can see it and untick it. It is handed back with
 * every other change, so an edit never shortens a stored answer.
 */
export interface DietaryPresetsProps<K extends string = DietaryPreset> {
  /** The current selection. Controlled — this component holds no state. */
  value: readonly K[];
  onChange: (next: readonly (K | DietaryPreset)[]) => void;
  /** Disables every checkbox and the trigger: submitting, saved, or past the
   *  RSVP deadline. */
  disabled?: boolean;
  /** Names whose requirements these are, for the group's accessible name. */
  label?: string;
  /** Wrap the pills into a column instead of a scrolling row. The popover shell
   *  sets it; inline callers leave it off. */
  wrap?: boolean;
}

function toggle<K extends string>(
  current: readonly K[],
  key: K | DietaryPreset,
  on: boolean,
): readonly (K | DietaryPreset)[] {
  const next = new Set<K | DietaryPreset>(current);
  if (on) next.add(key);
  else next.delete(key);
  // Known keys in canonical order, so the value this hands back is the order it
  // renders and the order the column stores. Keys this build does not know
  // trail them, once each: they are still the guest's answer, and the server
  // that sent them puts them back in its own canonical place on save.
  const result: (K | DietaryPreset)[] = DIETARY_PRESETS.filter((k) => next.has(k));
  for (const k of next) if (!isDietaryPreset(k)) result.push(k);
  return result;
}

function PresetCheckbox(props: {
  preset: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    // `relative` is not decoration. `sr-only` is `position: absolute`, so the
    // input below resolves against the nearest POSITIONED ancestor — and with a
    // static label that was whatever box happened to be positioned further up,
    // outside this scrolling track. The input then did not move with the
    // track's scroll, so clicking a pill scrolled focus toward a phantom
    // position hundreds of pixels away and dragged the whole sheet sideways
    // with it. Positioning the pill makes the pill the containing block, and
    // the input sits where it looks like it sits.
    //
    // It also makes each pill paint above non-positioned in-flow boxes, which
    // is why the sheets that hold this give their close chip an explicit
    // z-index. See wiki/shared/frontend-patterns.md.
    <label class="font-body border-ui-hairline text-ui-ink has-[:checked]:border-ui-accent has-[:checked]:bg-ui-accent-wash has-[:focus-visible]:ring-ui-focus text-ui-sm relative flex shrink-0 cursor-pointer snap-start items-center gap-2 rounded-full border px-3 py-1.5 whitespace-nowrap transition-colors duration-200 select-none has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2">
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
      <span aria-hidden="true" class="text-ui-accent text-ui-xs leading-none">
        {props.checked ? "✓" : "+"}
      </span>
      {presetLabel(props.preset)}
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

export default function DietaryPresets<K extends string = DietaryPreset>(
  props: DietaryPresetsProps<K>,
): JSX.Element {
  const selected = createMemo(() => new Set<string>(props.value));

  /**
   * The keys this build has no pill for, once each, in the order they first
   * appeared in the value.
   *
   * Remembered for as long as this picker is mounted, so unticking one leaves
   * its pill on screen, unticked: focus stays on the control the guest just
   * used rather than falling to the page, and the guest can tick it back.
   * Unmounting forgets them — the popover unmounts this when it closes, the
   * guest sheet when a member stops attending — and then only Cancel, closing
   * without saving, or a reload onto a build that knows the key brings an
   * unticked one back.
   *
   * Returns the previous array when nothing new arrived, so `<For>` keeps its
   * rows, and builds nothing on the common answer of known keys only. An empty
   * or blank key has no words to show, so it gets no pill, matching
   * `presetLabels`.
   */
  const unknown = createMemo<readonly K[]>((seen) => {
    let next: K[] | undefined;
    for (const key of props.value) {
      if (isDietaryPreset(key) || presetLabel(key) === "") continue;
      if ((next ?? seen).includes(key)) continue;
      (next ??= [...seen]).push(key);
    }
    return next ?? seen;
  }, []);

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
                <p class="font-body text-ui-ink-muted tracking-ui-wider text-ui-xs shrink-0 uppercase">
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
        {/* One trailing group, unheaded like `other`, so the pills render in
            the order the value is handed back in: known keys canonically,
            then these. */}
        <Show when={unknown().length > 0}>
          <div classList={{ "flex gap-2": true, "shrink-0": !props.wrap, "flex-wrap": props.wrap }}>
            <For each={unknown()}>
              {(key) => (
                <PresetCheckbox
                  preset={key}
                  checked={selected().has(key)}
                  disabled={props.disabled}
                  onChange={(on) => props.onChange(toggle(props.value, key, on))}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </fieldset>
  );
}
