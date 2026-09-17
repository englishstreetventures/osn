/**
 * The box every text control shares: `Input`, `Textarea` and `Select`.
 *
 * ## Why this is one module and not three class strings
 *
 * Counted across the products before the lift, the text input had drifted into
 * four shapes — `px-3 py-2 text-[0.9rem]` on cire's planning modules, the same
 * padding at `text-[0.95rem]` on its settings forms, `px-2 py-1` with no text
 * size at all in the guest editor's inline cells, and `px-2 py-1 text-[0.8rem]`
 * in the budget table. Three of the four had no focus treatment, so typing into
 * a guest row and typing into a wedding name looked like two different products.
 *
 * Two sizes, then, and nothing else: `md` for a form, `sm` for a control sitting
 * inside a table row. Both take the same focus ring, and `Select` takes the same
 * box so a date and a currency line up in a column.
 *
 * ## `size` is not the native attribute
 *
 * `<input size>` and `<select size>` size a box in characters and rows — neither
 * of which anything here wants, and both of which would collide with the name.
 * The prop types below omit the native one, so passing `size={30}` is a compile
 * error rather than a control that quietly ignores its variant.
 */

export type ControlSize = "sm" | "md";

/**
 * Everything that does not change with size.
 *
 * `aria-[invalid=true]:` rather than `aria-invalid:`: Tailwind's built-in `aria-*`
 * variants cover `busy`, `checked`, `disabled`, `expanded`, `hidden`, `pressed`,
 * `readonly`, `required` and `selected` — not `invalid`. This is the pair that
 * makes `Field`'s error state visible on the control itself rather than only in
 * the message below it, so it is load-bearing rather than decorative.
 */
const CONTROL_BASE =
  "base:border-ui-hairline-strong base:bg-ui-ground base:text-ui-ink " +
  "base:ring-offset-ui-ground base:placeholder:text-ui-ink-secondary " +
  "base:w-full base:rounded-ui-control base:border " +
  "base:focus-visible:ring-ui-focus base:focus-visible:outline-none " +
  "base:focus-visible:ring-2 base:focus-visible:ring-offset-2 " +
  "base:aria-[invalid=true]:border-ui-danger " +
  "base:disabled:cursor-not-allowed base:disabled:opacity-50";

const CONTROL_SIZE = {
  sm: "base:px-2 base:py-1 base:text-ui-sm",
  md: "base:px-3 base:py-2 base:text-ui-base",
} satisfies Readonly<Record<ControlSize, string>>;

/**
 * The shared box at one size, with the caller's own classes after it.
 *
 * The caller's string goes last so a call site can still override — every class
 * above is `base:`-prefixed and therefore zero-specificity, so ordering in the
 * generated stylesheet is what decides, and later wins.
 */
export function controlClass(size: ControlSize | undefined, extra: string | undefined): string {
  return `${CONTROL_BASE} ${CONTROL_SIZE[size ?? "md"]}${extra ? ` ${extra}` : ""}`;
}
