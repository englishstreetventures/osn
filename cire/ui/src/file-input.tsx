import type { SafeProps } from "@shared/ui/ui/props";
import { splitProps, type JSX } from "solid-js";

import { FILE_BUTTON } from "./button";

export type FileInputProps = Omit<SafeProps<"input">, "type">;

/**
 * The file name beside the button, and the input as a whole: body ink at the
 * small step, the house focus outline on the input (the button inside it
 * cannot take focus), and a disabled picker faded to 40% as `Button` is.
 */
const FILE_INPUT =
  "base:font-ui-body base:text-ui-sm base:text-ui-ink " +
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus " +
  "base:disabled:opacity-40 base:disabled:cursor-not-allowed";

/**
 * A native `<input type="file">` whose button is drawn as a quiet pill
 * ({@link FILE_BUTTON}), at the form-field height.
 *
 * Every prop reaches the input — `accept`, `multiple`, `name`, `id`,
 * `disabled`, `onChange`, `ref` and the `aria-*` wiring `Field` hands over. A
 * picker with no visible label beside it needs an `aria-label`. `class` places
 * it; it does not restyle it.
 */
export default function FileInput(props: FileInputProps): JSX.Element {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <input
      type="file"
      class={`${FILE_INPUT} ${FILE_BUTTON}${local.class ? ` ${local.class}` : ""}`}
      {...others}
    />
  );
}
