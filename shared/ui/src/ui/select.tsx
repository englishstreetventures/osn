import { splitProps, type Component } from "solid-js";

import { controlClass, type ControlSize } from "./control";
import type { SafeProps } from "./props";

/**
 * A native `<select>`, in the same box as {@link Input}.
 *
 * Native because no combobox in this repository behaves on a phone and the
 * platform one does: the OS picker, the hardware keyboard, the voice control and
 * the screen reader all already know what this element is, and a listbox built
 * from `<div>`s has to re-earn every one of those.
 *
 * `cursor-pointer` where `Input` has none, because the two are not the same
 * gesture — a select is a thing you open, not a thing you type in, and a text
 * caret over it reads as an editable box.
 */
type SelectProps = Omit<SafeProps<"select">, "size"> & {
  /** {@link ControlSize} — the shared control box, not the native visible-rows count. */
  size?: ControlSize;
};

const Select: Component<SelectProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "size"]);
  return (
    <select class={`base:cursor-pointer ${controlClass(local.size, local.class)}`} {...others} />
  );
};

export { Select };
export type { SelectProps };
