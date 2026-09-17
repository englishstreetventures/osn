import { splitProps, type Component } from "solid-js";

import { controlClass, type ControlSize } from "./control";
import type { SafeProps } from "./props";

export type TextareaResize = "y" | "none";

const TEXTAREA_RESIZE = {
  y: "base:resize-y",
  none: "base:resize-none",
} satisfies Readonly<Record<TextareaResize, string>>;

type TextareaProps = Omit<SafeProps<"textarea">, "size"> & {
  /** {@link ControlSize} — the shared control box. */
  size?: ControlSize;
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
  const [local, others] = splitProps(props, ["class", "size", "resize"]);
  return (
    <textarea
      class={`base:flex base:min-h-15 ${controlClass(local.size, local.class)} ${TEXTAREA_RESIZE[local.resize ?? "y"]}`}
      {...others}
    />
  );
};

export { Textarea };
export type { TextareaProps };
