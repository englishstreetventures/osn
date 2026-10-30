import type { SafeProps } from "@shared/ui/ui/props";
import { splitProps, type JSX } from "solid-js";

export type FileInputProps = Omit<SafeProps<"input">, "type">;

/**
 * `quiet` at `md`, drawn on a file input's `::file-selector-button`, at the
 * 34px form-field height (`@shared/ui`'s `CONTROL_HEIGHT.form`, and the
 * portal's `FORM_ACTION_CLASS`), so a picker lines up with the fields and
 * buttons in its row.
 *
 * A literal, not `buttonClass` with `file:` added at run time: Tailwind writes
 * CSS only for the classes it finds in the source, so a computed class emits
 * nothing. `tests/file-input.test.tsx` derives it from `button.tsx`'s
 * `buttonLook` and fails on any drift. It lives here, not beside `Button`, so a
 * site with no picker can leave this file out of its Tailwind sources and ship
 * none of its rules. `file:` goes straight before each utility, after any
 * state on the input (`enabled:hover:`), so the pseudo-element comes last and
 * the hover answers the pointer anywhere on the picker. Only an enabled picker
 * answers it, since a disabled one is still hovered. Its fade is `Button`'s,
 * and stops under reduced motion, which a page's `*` rule does not reach.
 */
export const FILE_BUTTON =
  "base:file:border base:file:border-ui-hairline base:file:bg-transparent base:file:text-ui-ink-secondary " +
  "base:enabled:hover:file:border-ui-accent base:enabled:hover:file:text-ui-accent-ink " +
  "base:file:rounded-ui-control base:file:font-ui-body " +
  "base:file:px-5 base:file:py-0 base:file:h-8.5 base:file:text-ui-sm base:file:font-medium base:file:tracking-ui-normal " +
  "base:file:mr-3 base:enabled:file:cursor-pointer base:disabled:file:cursor-not-allowed " +
  "base:file:transition-[color,background-color,border-color,text-decoration-color] " +
  "base:file:duration-(--dur-fast,100ms) base:file:ease-out base:motion-reduce:file:transition-none";

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
