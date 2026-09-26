/**
 * The invite builder's shared form primitives: labelled text inputs and
 * textareas (with live character counters against the server caps), closed-set
 * dropdowns, range sliders, the per-section visibility badge and switch, and
 * the section-card chrome every builder section shares. `EventTable`'s image field
 * imitates patterns from here — if a primitive grows a second consumer, move
 * it to the shared component library rather than copying it again.
 *
 * Label styling: field labels are sentence-case at a readable size — the
 * tracked micro-caps treatment is reserved for the fieldset legends
 * (`SectionCard`), where it is chrome rather than the primary label of an
 * input the organiser is actively filling in.
 */

import type { SectionState } from "@cire/theme";
import Button from "@cire/ui/button";
import { Input } from "@shared/ui/ui/input";
import { Select } from "@shared/ui/ui/select";
import { Textarea } from "@shared/ui/ui/textarea";
import { createUniqueId, For, type JSX, Show } from "solid-js";
const LABEL_CLASS = "font-body text-text-muted text-ui-sm";

/**
 * Live length counter against a field's server cap (`COPY_CAPS`). Textareas
 * show it always; single-line inputs only once the value nears the cap, so
 * short fields aren't cluttered by a counter nobody needs.
 */
function CapCounter(props: { length: number; max: number; always?: boolean }) {
  const visible = () => (props.always ?? false) || props.length >= props.max * 0.7;
  return (
    <Show when={visible()}>
      <span
        class="font-body text-ui-xs tabular-nums"
        classList={{
          "text-error": props.length >= props.max,
          "text-text-muted": props.length < props.max,
        }}
      >
        {props.length}/{props.max}
      </span>
    </Show>
  );
}

export function TextField(props: {
  label: string;
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  /** Server-side character cap (mirrors `InviteTextBody`) — enforced via
   *  `maxlength` and surfaced as a counter when the value nears it. */
  maxLength?: number;
}) {
  // Explicit for/id (not a wrapping label): the counter shares the label row,
  // and inside a wrapping <label> its text would pollute the accessible name.
  const id = createUniqueId();
  return (
    <div class="flex flex-col gap-1.5">
      <span class="flex items-baseline justify-between gap-2">
        <label for={id} class={LABEL_CLASS}>
          {props.label}
        </label>
        <Show when={props.maxLength}>
          <CapCounter length={props.value.length} max={props.maxLength!} />
        </Show>
      </span>
      <Input
        id={id}
        placeholder={props.placeholder}
        value={props.value}
        maxlength={props.maxLength}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </div>
  );
}

export function TextAreaField(props: {
  label: string;
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  rows?: number;
  maxLength?: number;
  hint?: string;
}) {
  const id = createUniqueId();
  return (
    <div class="flex flex-col gap-1.5">
      <span class="flex items-baseline justify-between gap-2">
        <label for={id} class={LABEL_CLASS}>
          {props.label}
        </label>
        <Show when={props.maxLength}>
          <CapCounter length={props.value.length} max={props.maxLength!} always />
        </Show>
      </span>
      <Textarea
        id={id}
        rows={props.rows ?? 4}
        placeholder={props.placeholder}
        value={props.value}
        maxlength={props.maxLength}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        // The invite builder is a module view, and every module view renders
        // inside `ModuleShell`'s auto-sized frame, whose reflow guard keys
        // on width only — a user-resizable textarea in here would have a
        // height-only drag misread as a content swap and trigger continuous
        // relayout, so this must stay resize-none.
        resize="none"
      />
      <Show when={props.hint}>
        <span class="font-body text-text-muted text-ui-xs italic">{props.hint}</span>
      </Show>
    </div>
  );
}

/** A labelled dropdown over a closed option set (fonts, typography options). */
export function ChoiceField(props: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class={LABEL_CLASS}>{props.label}</span>
      <Select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
        <For each={props.options}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
      </Select>
    </label>
  );
}

/**
 * A labelled range slider for a bounded integer hero-display setting (blur,
 * backdrop opacity/blur). Shows the live value readout next to the label and an
 * optional hint. The native `<input type="range">` is value-clamped to
 * [min,max] by the browser, and the server re-clamps on save. `valueText`
 * translates the raw number for assistive tech ("0 — sharp photo") — the
 * visual hint explains the scale, so the accessible value should too.
 */
export function SliderField(props: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  value: number;
  onInput: (v: number) => void;
  valueText?: (v: number) => string;
}) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="flex items-baseline justify-between gap-2">
        <span class={LABEL_CLASS}>{props.label}</span>
        <span class="font-body text-gold text-ui-xs tabular-nums">{props.value}</span>
      </span>
      <input
        type="range"
        aria-label={props.label}
        aria-valuetext={props.valueText?.(props.value)}
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
        class="accent-gold h-1.5 w-full cursor-pointer"
      />
      <Show when={props.hint}>
        <span class="font-body text-text-muted text-ui-xs italic">{props.hint}</span>
      </Show>
    </label>
  );
}

/** The badge's words for each state — also the wording of the tab clauses. */
export const SECTION_STATE_LABELS = {
  shown: "Shown",
  empty: "Hidden — empty",
  off: "Hidden — switched off",
} as const satisfies Record<SectionState, string>;

/**
 * A small per-section status badge telling the organiser whether this section
 * will render on the live guest invite: "Shown" when it is switched on and has
 * content, "Hidden — empty" when it is switched on with nothing in it, "Hidden —
 * switched off" when its switch is off (mirrors the guest-side state functions
 * in `../../lib/invite-emptiness`). It updates live as the fields and the switch
 * change, and announces the flip (`role="status"`) so a screen-reader user hears
 * the new state the moment their edit changes it.
 */
export function SegmentBadge(props: { state: SectionState }) {
  const shown = () => props.state === "shown";
  return (
    <span
      data-segment-badge
      data-shown={shown() ? "true" : "false"}
      data-state={props.state}
      role="status"
      class="font-body text-ui-xs tracking-ui-wider inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 uppercase"
      classList={{
        "border-gold/40 text-gold bg-gold/5": shown(),
        "border-border text-text-muted bg-bg/40": !shown(),
      }}
    >
      <span
        aria-hidden
        class="inline-block h-1.5 w-1.5 rounded-full"
        classList={{ "bg-gold": shown(), "bg-text-muted/60": !shown() }}
      />
      {SECTION_STATE_LABELS[props.state]}
    </span>
  );
}

/**
 * What a switchable section's card needs: the state the badge shows, the switch
 * and its setter, and the words for why a hidden section is hidden.
 */
export interface SectionVisibility {
  state: SectionState;
  visible: boolean;
  onChange: (visible: boolean) => void;
  /** What would give an empty section content, e.g. "a title, a subtitle or an
   *  image" — named in the line shown while it is switched on but empty. */
  emptyHint: string;
  /** Replaces the default switched-off line, for a section whose content is
   *  also read elsewhere on the invite (the hero's title and photo). */
  offNote?: string;
}

// The last sentence is deliberate: the invite stops showing the section, but a
// photo already uploaded to it keeps serving at its own address, which the
// builder's thumbnail uses too. Switching off must not read as making it private.
const DEFAULT_OFF_NOTE =
  "Switched off. Guests won't see this section on the invite; everything in it is kept for when you switch it back on. Switching off hides the section — it does not make its photo private.";

/**
 * The reason a switchable section is hidden, in words, under its badge: switched
 * on but empty says what to add; switched off says the content is kept. Nothing
 * while the section is shown.
 */
function VisibilityReason(props: { visibility: SectionVisibility }) {
  return (
    <Show when={props.visibility.state !== "shown"}>
      <p data-visibility-reason class="font-body text-text-muted text-ui-sm">
        {props.visibility.state === "empty"
          ? `Switched on, but guests won't see it until it has content: add ${props.visibility.emptyHint}.`
          : (props.visibility.offNote ?? DEFAULT_OFF_NOTE)}
      </p>
    </Show>
  );
}

/** A small "applies immediately" marker for the controls that bypass the save
 *  bar (image upload/remove/crop, design selection) — the one visual cue that
 *  separates the two persistence models the builder mixes. */
export function InstantBadge() {
  return (
    <span class="font-body border-border text-text-muted text-ui-xs tracking-ui-wider rounded-full border px-2 py-0.5 uppercase">
      Applies immediately
    </span>
  );
}

/**
 * The chrome every builder section shares: a fieldset that doubles as an ARIA
 * `tabpanel` for the section nav's `id`/`aria-labelledby` pair (`props.id` is
 * both the fieldset's DOM id — the tab's `aria-controls` target — and half of
 * `${id}-tab`, the tab's own id), the micro-caps legend, the optional visibility
 * badge + switch + reason line, the optional per-section reset, and the optional
 * description paragraph. Keeping this in one place is what keeps eight section
 * cards from drifting apart.
 */
export function SectionCard(props: {
  id: string;
  legend: string;
  /** Present ⇒ the section has a visibility switch: render the state badge, the
   *  "Show on the invite" switch and, while hidden, the reason. */
  visibility?: SectionVisibility;
  description?: JSX.Element;
  /** Present ⇒ render a "Reset section" action that reverts the section's
   *  saveable fields to their defaults (a draft change — nothing is saved). */
  onReset?: () => void;
  /** The builder shows one section at a time (a tab, not a scroll) — the
   *  inactive cards stay MOUNTED (their draft state, dirty tracking and inline
   *  previews all live regardless of visibility) and are hidden with the
   *  native `hidden` attribute rather than unmounted. */
  hidden?: boolean;
  children: JSX.Element;
}) {
  return (
    <fieldset
      id={props.id}
      hidden={props.hidden}
      role="tabpanel"
      aria-labelledby={`${props.id}-tab`}
      class="border-border flex flex-col gap-4 rounded-sm border p-4"
    >
      <legend class="font-body text-gold-dim text-ui-xs tracking-ui-wider px-2 uppercase">
        {props.legend}
      </legend>
      <Show when={props.visibility !== undefined || props.onReset}>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <Show when={props.visibility} fallback={<span aria-hidden />}>
            {(visibility) => (
              <span class="flex flex-wrap items-center gap-4">
                <SegmentBadge state={visibility().state} />
                {/* A native checkbox, as elsewhere in the portal: the input
                  itself takes keyboard focus and shows the dashboard's
                  `:focus-visible` ring. */}
                <label class="font-body text-text text-ui-sm flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-visibility-switch
                    class="accent-gold h-4 w-4 shrink-0 cursor-pointer"
                    checked={visibility().visible}
                    onChange={(e) => visibility().onChange(e.currentTarget.checked)}
                  />
                  Show on the invite
                </label>
              </span>
            )}
          </Show>
          <Show when={props.onReset}>
            <Button variant="subtle" size="sm" type="button" onClick={() => props.onReset!()}>
              Reset section
            </Button>
          </Show>
        </div>
        <Show when={props.visibility}>
          {(visibility) => <VisibilityReason visibility={visibility()} />}
        </Show>
      </Show>
      <Show when={props.description}>
        <p class="font-body text-text-muted text-ui-sm">{props.description}</p>
      </Show>
      {props.children}
    </fieldset>
  );
}

/**
 * A native-`details` progressive disclosure for secondary controls (the hero
 * display sliders, the fine typography options) — the happy path stays light
 * and the knobs remain one click away. Free keyboard + SR semantics.
 */
export function Disclosure(props: { summary: string; hint?: string; children: JSX.Element }) {
  return (
    <details class="border-border rounded-sm border">
      <summary class="font-body text-text-muted hover:text-text text-ui-sm tracking-ui-wide cursor-pointer px-3 py-2 uppercase select-none">
        {props.summary}
        <Show when={props.hint}>
          <span class="text-text-muted/70 ml-2 normal-case italic">{props.hint}</span>
        </Show>
      </summary>
      <div class="flex flex-col gap-4 px-3 pt-1 pb-3">{props.children}</div>
    </details>
  );
}
