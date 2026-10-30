import { splitProps, type Component } from "solid-js";

import {
  controlClass,
  CONTROL_HEIGHT,
  type ControlFace,
  type ControlFill,
  type ControlSize,
} from "./control";
import type { SafeProps } from "./props";

/**
 * A single-line text box.
 *
 * `type` is not defaulted here: an `<input>` with no `type` already behaves as
 * `text`, and writing the default in would mean a caller's `type="email"` has to
 * win a spread order rather than simply being the only value.
 */
type InputProps = Omit<SafeProps<"input">, "size"> & {
  /** {@link ControlSize} — the shared control box, not the native character count. */
  size?: ControlSize;
  /** {@link ControlFace} — how the value is set: `code`, `claim` or `amount`. */
  face?: ControlFace;
  /** {@link ControlFill} — `ink` for a field on a surface the page does not choose. */
  fill?: ControlFill;
};

const FILE =
  "base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium";

const Input: Component<InputProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "size", "face", "fill"]);
  return (
    <input
      class={`base:flex ${CONTROL_HEIGHT[local.size ?? "md"]} ${FILE} ${controlClass(local.size, local.class, local.face, local.fill)}`}
      {...others}
    />
  );
};

export { Input };
export type { InputProps };
