/**
 * What `Checkbox`, `RadioGroupItem` and `Switch` share: the two ways a box is
 * drawn, the label's two type steps, and the one rule for a row
 * (`wiki/shared/component-library.md` §Choice controls).
 *
 * ## One row
 *
 * The control sits on its words' first line, whatever their length, 8px from
 * them, and the words are set at prose leading. `touch` makes the row a 44px
 * target below `md` without moving anything (`TOUCH_ROW`).
 *
 * ## Two boxes
 *
 * `drawn` paints its own box beside a visually hidden input: 16px, the small
 * corner, the ground for a fill, the accent and a tick (or a dot) when chosen,
 * and the house focus outline from the input's `:focus-visible`. Musubi and
 * pulse draw their forms this way.
 *
 * `native` is the browser's own input, visible. Ticked, it is the browser's
 * box — the platform's blue and tick, which reads as a form control. Unticked,
 * this module draws it so it sits on its surface rather than standing out as a
 * white square: no fill, the choice edge (`--ui-choice-edge`) for an edge, 2px
 * corners (a radio round), the secondary ink for the edge under the pointer,
 * 40% when disabled.
 * Both states keep the native box's 13px, so ticking moves nothing. Cire draws
 * every checkbox and radio this way, and its apps draw any bare native box
 * with the same values in a base-layer rule (`cire/host/DESIGN.md` §4,
 * "Checkboxes and radios").
 */

import type { JSX } from "solid-js";

export type ChoiceBox = "drawn" | "native";

/**
 * The label's type step: `md` (`text-ui-base`) or `sm` (`text-ui-sm`). Only the
 * words change; the box keeps its size.
 */
export type ChoiceSize = "sm" | "md";

/**
 * The native box, either kind. The unticked look is gated on `not-checked:`,
 * so a ticked box is left entirely to the browser (`appearance: auto`).
 *
 * Only `border-color` fades, on the app's `--dur-fast` where it declares one
 * (cire) and the contract's `--ui-dur-fast` elsewhere, so the focus outline
 * lands at once. The outline is the house ring: 2px, 2px off, `--ui-focus`.
 */
const NATIVE_BOX =
  "base:m-0 base:size-[13px] base:shrink-0 base:cursor-pointer base:disabled:cursor-not-allowed " +
  "base:not-checked:appearance-none base:not-checked:border " +
  "base:not-checked:border-ui-choice-edge base:not-checked:bg-transparent " +
  "base:not-checked:enabled:hover:border-ui-ink-secondary " +
  "base:not-checked:disabled:opacity-40 " +
  "base:transition-[border-color] base:duration-[var(--dur-fast,var(--ui-dur-fast))] " +
  "base:ease-[var(--ease-out,var(--ui-ease-out))] " +
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus";

export const NATIVE_CHECKBOX = `${NATIVE_BOX} base:not-checked:rounded-[2px]`;
export const NATIVE_RADIO = `${NATIVE_BOX} base:not-checked:rounded-[50%]`;

/** The native label: body ink at either step, at prose leading so a second line reads. */
export const NATIVE_TEXT = {
  sm: "base:text-ui-ink base:text-ui-sm base:leading-ui-normal",
  md: "base:text-ui-ink base:text-ui-base base:leading-ui-normal",
} satisfies Readonly<Record<ChoiceSize, string>>;

/**
 * The drawn label, which takes the ink of whatever it sits in, at prose
 * leading: a second line reads, and the first-line slot ({@link FIRST_LINE})
 * is tall enough for the 16px box. A radio group sets it on itself too, so a
 * length in `lh` on the group is one of its rows' lines ({@link TOUCH_PULL}).
 */
export const DRAWN_TEXT = {
  sm: "base:text-ui-sm base:leading-ui-normal",
  md: "base:text-ui-base base:leading-ui-normal",
} satisfies Readonly<Record<ChoiceSize, string>>;

/**
 * A native row: the label is the whole hit area, so it says so under the
 * pointer, and says otherwise when its input is disabled.
 */
export const NATIVE_ROW =
  "base:flex base:items-start base:gap-2 base:cursor-pointer base:has-disabled:cursor-not-allowed";

/**
 * A slot one line of the label tall that centres the control in it, so the
 * control sits on the first line whatever the label's size or length. The row
 * aligns its items to the start, so the slot is the first line.
 */
export const FIRST_LINE = "base:flex base:h-lh base:shrink-0 base:items-center";

/**
 * The drawn row: the words beside the slot, 8px off, the row the whole hit
 * area. `group/choice` is a marker for the drawn box's hover edge, not a
 * utility.
 */
export const DRAWN_ROW =
  "group/choice base:flex base:items-start base:gap-2 base:cursor-pointer base:has-disabled:cursor-not-allowed";

/**
 * `touch`: below `md`, a row padded above and below by half of what one line
 * of its words falls short of 44px, so a one-line row is a 44px target and a
 * longer one grows by its lines. `lh` is the row's own line, so the padding
 * is right at either type step.
 */
export const TOUCH_ROW = "max-md:base:py-[max(0px,calc((var(--spacing)*11_-_1lh)/2))]";

/**
 * The same amount taken back outside, so a `touch` row or group sits where it
 * would without `touch` and only its hit area grows. On a group it pulls in
 * the first row's top and the last row's bottom; its rows abut, so one
 * option's target ends where the next begins and none overlap.
 */
export const TOUCH_PULL = "max-md:base:-my-[max(0px,calc((var(--spacing)*11_-_1lh)/2))]";

/**
 * The drawn box, circle and track's focus: the house outline, 2px of
 * `--ui-focus` 2px off, drawn from the hidden input's `:focus-visible`. An
 * outline, so a contrast theme keeps it, and it arrives at once: the
 * transition below fades colours, never the outline.
 */
export const DRAWN_FOCUS =
  "base:peer-focus-visible:outline-2 base:peer-focus-visible:outline-offset-2 base:peer-focus-visible:outline-ui-focus";

/**
 * The drawn box's fade: its fill and edge, on Tailwind's default duration and
 * curve (each cire app sets the curve to its own), and not the outline.
 */
export const DRAWN_FADE = "base:transition-[color,background-color,border-color]";

/**
 * The drawn box's resting edge under the pointer: the secondary ink while the
 * row is hovered, unless the box is chosen or disabled, as the native box's.
 */
export const DRAWN_HOVER =
  "base:group-hover/choice:not-data-[checked]:not-data-[disabled]:border-ui-ink-secondary";

/**
 * A description inside the label, under it: what the choice does, in the
 * secondary ink, a step smaller.
 */
export const DESCRIPTION =
  "base:mt-1 base:block base:text-ui-sm base:leading-ui-normal base:text-ui-ink-secondary";

/**
 * The slot under a row, outside its label: indented by the box and the gap, so
 * its first word starts under the label's.
 */
export const NOTE_INDENT = {
  native: "base:ps-[calc(13px_+_var(--spacing)*2)]",
  drawn: "base:ps-[calc(var(--spacing)*4_+_var(--spacing)*2)]",
} satisfies Readonly<Record<ChoiceBox, string>>;

/**
 * The outer element: the row, then the slot 6px below it. Each at its own
 * width, so only the box and its words answer a click, not the rest of the
 * line.
 */
export const WRAP = "base:flex base:flex-col base:items-start base:gap-1.5";

/**
 * Whether resolved JSX holds anything to show. A slot passed a `<Show>` whose
 * condition is false resolves to nothing, and then the part draws no slot,
 * leaves no gap and points no `aria-describedby` at an empty element.
 */
export function present(node: JSX.Element): boolean {
  if (Array.isArray(node)) return node.some(present);
  return node !== undefined && node !== null && node !== false && node !== "";
}

/** Joins the ids that describe an input, or gives nothing when there are none. */
export function idList(...ids: (string | false | undefined)[]): string | undefined {
  const list = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return list.length > 0 ? list.join(" ") : undefined;
}
