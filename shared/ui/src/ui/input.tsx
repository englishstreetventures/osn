import { splitProps, type Component } from "solid-js";

import { controlClass, type ControlSize } from "./control";
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
};

/** Height is `Input`'s own: a `Textarea` sized this way would be a single line. */
const INPUT_HEIGHT = {
  sm: "base:h-7",
  md: "base:h-9",
} satisfies Readonly<Record<ControlSize, string>>;

const FILE =
  "base:file:border-0 base:file:bg-transparent base:file:text-ui-base base:file:font-medium";

const Input: Component<InputProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "size"]);
  return (
    <input
      class={`base:flex ${INPUT_HEIGHT[local.size ?? "md"]} ${FILE} ${controlClass(local.size, local.class)}`}
      {...others}
    />
  );
};

export { Input };
export type { InputProps };
