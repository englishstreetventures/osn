import { splitProps, type Component } from "solid-js";

import { composeControl, type ControlFill, type ControlSize } from "./control";
import type { SafeProps } from "./props";

export type TextareaResize = "y" | "none";

const TEXTAREA_RESIZE = {
  y: "base:resize-y",
  none: "base:resize-none",
} satisfies Readonly<Record<TextareaResize, string>>;

/**
 * A textarea's padding at each size. The fixed-height sizes give `Input` no top
 * or bottom padding, since the engine centres one line; a textarea grows with
 * its rows and needs both.
 */
const TEXTAREA_PAD = {
  sm: "base:px-2 base:py-1",
  md: "base:px-3 base:py-2",
  form: "base:px-3 base:py-2",
  "form-compact": "base:px-2 base:py-1",
  touch: "base:px-3 base:py-2.5",
} satisfies Readonly<Record<ControlSize, string>>;

type TextareaProps = Omit<SafeProps<"textarea">, "size"> & {
  /** {@link ControlSize} — the shared control box; a textarea takes its padding
   *  and type, never its height. */
  size?: ControlSize;
  /** {@link ControlFill} — `ink` for a field on a surface the page does not choose. */
  fill?: ControlFill;
  /**
   * `"y"` by default on purpose: sideways resize breaks the column a textarea
   * sits in, and no-resize takes away the one control a writer has over a long
   * note.
   *
   * `"none"` exists for the case that default is wrong — a textarea inside an
   * auto-sized frame (cire's `lib/auto-size.ts`). That observer's reflow guard
   * watches width only; dragging this textarea's own resize grip changes height
   * at a fixed width, which the guard reads as a content change on every
   * delivery, forcing continuous relayout for as long as the drag continues.
   *
   * It has to be a prop rather than a passed `class="resize-none"`: this
   * component appends its own resize class after the caller's, so both land on
   * the element and Tailwind resolves the conflict by the two utilities' order
   * in the generated stylesheet, not by their order in the attribute — the
   * caller's class does not reliably win.
   */
  resize?: TextareaResize;
};

const Textarea: Component<TextareaProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "size", "fill", "resize"]);
  const size = () => local.size ?? "md";
  return (
    <textarea
      class={`base:flex base:min-h-15 ${composeControl(size(), undefined, local.fill, TEXTAREA_PAD[size()])}${local.class ? ` ${local.class}` : ""} ${TEXTAREA_RESIZE[local.resize ?? "y"]}`}
      {...others}
    />
  );
};

export { Textarea };
export type { TextareaProps };
