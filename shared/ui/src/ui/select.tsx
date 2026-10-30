import { clsx } from "clsx";
import { splitProps, type Component } from "solid-js";

import {
  composeControl,
  CONTROL_HEIGHT,
  isWideBox,
  type ControlFill,
  type ControlSize,
} from "./control";
import type { SafeProps } from "./props";

/**
 * A native `<select>`, in the same box as {@link Input}, with a chevron of its
 * own.
 *
 * Native because no combobox in this repository behaves on a phone and the
 * platform one does: the OS picker, the hardware keyboard, the voice control and
 * the screen reader all already know what this element is, and a listbox built
 * from `<div>`s has to re-earn every one of those.
 *
 * The browser's own arrow sits about 4px from the edge whatever the padding,
 * which crowds a rounded corner and nearly touches a pill's end. So the arrow is
 * off (`appearance: none`) and the part draws a 10×6 chevron in the secondary
 * ink: 12px in from the right on a box with 12px sides, 10px on one with 8px
 * sides, with right padding that keeps a long value clear of it. The select has
 * a fixed height and no top or bottom padding, so the engine centres the value.
 *
 * The select and the chevron share the one cell of a grid, so the select needs
 * no percentage width: it stretches to the cell, and gives the cell its own
 * width when the caller sizes the box to its content. The caller's `class`,
 * `classList`, `style` and `hidden` go on that box — they place, size and show
 * the field, and cannot restyle it. Every other prop (`id`, `value`, `ref`, the
 * `aria-*` wiring `Field` hands over) goes on the select.
 *
 * `cursor-pointer` where `Input` has none, because the two are not the same
 * gesture — a select is a thing you open, not a thing you type in, and a text
 * caret over it reads as an editable box.
 */
type SelectProps = Omit<SafeProps<"select">, "size"> & {
  /** {@link ControlSize} — the shared control box, not the native visible-rows count. */
  size?: ControlSize;
  /** {@link ControlFill} — `ink` for a field on a surface the page does not choose. */
  fill?: ControlFill;
};

/** Room for the chevron: its inset, its 10px and a gap before the value. */
const SELECT_PAD = {
  wide: "base:pl-3 base:pr-8.5",
  narrow: "base:pl-2 base:pr-7",
} as const;

/** The chevron's distance from the field's right edge. */
const CHEVRON_INSET = {
  wide: "base:mr-3",
  narrow: "base:mr-2.5",
} as const;

const Select: Component<SelectProps> = (props) => {
  const [local, box, others] = splitProps(
    props,
    ["size", "fill"],
    ["class", "classList", "style", "hidden"],
  );
  const size = () => local.size ?? "md";
  const width = () => (isWideBox(size()) ? "wide" : "narrow");
  return (
    <span
      class={clsx("base:grid base:w-full", CONTROL_HEIGHT[size()], box.class)}
      classList={box.classList}
      style={box.style}
      hidden={box.hidden}
    >
      <select
        class={`peer base:col-start-1 base:row-start-1 base:cursor-pointer base:appearance-none ${composeControl(
          size(),
          undefined,
          local.fill,
          SELECT_PAD[width()],
          false,
        )}`}
        {...others}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 10 6"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class={`base:text-ui-ink-secondary base:pointer-events-none base:col-start-1 base:row-start-1 base:h-1.5 base:w-2.5 base:self-center base:justify-self-end base:peer-disabled:opacity-50 ${CHEVRON_INSET[width()]}`}
      >
        <path d="M1 1l4 4 4-4" />
      </svg>
    </span>
  );
};

export { Select };
export type { SelectProps };
