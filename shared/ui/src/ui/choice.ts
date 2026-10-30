/**
 * What `Checkbox` and `RadioGroupItem` share: the two ways their box is drawn,
 * the label's two type steps, and the row's layout.
 *
 * ## Two boxes
 *
 * `drawn` paints its own box beside a visually hidden input: 16px, the small
 * corner, the ground for a fill, the accent and a tick (or a dot) when chosen,
 * and a ring from the input's `:focus-visible`. Pulse draws its forms this way.
 *
 * `native` is the browser's own input, visible. Ticked, it is the browser's
 * box — the platform's blue and tick, which reads as a form control. Unticked,
 * this module draws it so it sits on its surface rather than standing out as a
 * white square: no fill, the strong hairline for an edge, 2px corners (a radio
 * round), the secondary ink for the edge under the pointer, 40% when disabled.
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
 * Where the box sits beside a label that wraps: `center` on the whole label,
 * `start` on its first line. One line of label reads the same either way.
 */
export type ChoiceAlign = "center" | "start";

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
  "base:not-checked:border-ui-hairline-strong base:not-checked:bg-transparent " +
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

/** The drawn label: pulse's, which takes the ink of whatever it sits in. */
export const DRAWN_TEXT = {
  sm: "base:text-ui-sm base:leading-none",
  md: "base:text-ui-base base:leading-none",
} satisfies Readonly<Record<ChoiceSize, string>>;

/**
 * A native row: the label is the whole hit area, so it says so under the
 * pointer, and says otherwise when its input is disabled.
 */
export const NATIVE_ROW =
  "base:flex base:gap-2 base:cursor-pointer base:has-disabled:cursor-not-allowed";

/** Box against the label's middle, or against its first line. */
export const ROW_ALIGN = {
  center: "base:items-center",
  start: "base:items-start",
} satisfies Readonly<Record<ChoiceAlign, string>>;

/**
 * For `align="start"`: a box one line of the label tall that centres the
 * input, so the box sits on the first line whatever the label's size.
 */
export const FIRST_LINE = "base:flex base:h-lh base:shrink-0 base:items-center";

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
