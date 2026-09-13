import { splitProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * The portal's button.
 *
 * Every control in the dashboard was already one of four shapes — a solid gold
 * commit, a gold-outlined secondary, a neutral-outlined quiet action, and a
 * destructive one — written out longhand at each of the ~40 call sites, which is
 * why three of them had drifted to a different padding and two to a different
 * tracking. This is those four, named.
 *
 * ## No haptic here
 *
 * Tempting, and wrong. The vocabulary in `haptics.ts` is deliberately five
 * names, fired at the moment a change *takes* — not at the moment a button is
 * pressed. A press that opens a dialog, switches a tab or starts a request that
 * then fails has nothing to confirm yet. Buzzing on every press is exactly the
 * "phone in a pocket buzzing through a seating chart" the module warns about.
 *
 * ## About `class`
 *
 * The prop is appended, and there is no `tailwind-merge` in this package, so it
 * is for what the variant does not decide — `self-start`, `w-full`, a grid
 * placement. Two competing utilities land in source order, not in the order they
 * are written here. Anything that needs a different colour or padding wants a
 * new variant, not an override.
 */

export type ButtonVariant = "primary" | "outline" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

const BASE =
  "font-body inline-flex items-center justify-center gap-2 rounded-sm border whitespace-nowrap " +
  "uppercase transition-colors duration-(--dur-fast) ease-(--ease-out) " +
  "disabled:pointer-events-none disabled:opacity-40 " +
  // `aria-disabled` is the other way to say it: the control stays in the tab
  // order and keeps its description reachable, and the click is swallowed here
  // rather than left to each caller. Used where the point is that someone READS
  // why they cannot press it — a `disabled` button is skipped by the keyboard
  // and by a screen reader in forms mode, which hides the explanation from
  // exactly the person asking.
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

const VARIANT = {
  primary: "border-gold bg-gold text-bg hover:bg-gold-dim",
  outline: "border-gold/40 text-gold hover:border-gold hover:bg-gold/10",
  quiet: "border-border text-text-muted hover:border-gold hover:text-gold",
  danger: "border-error/40 text-error hover:border-error hover:bg-error/10",
} satisfies Readonly<Record<ButtonVariant, string>>;

const SIZE = {
  sm: "px-3 py-1.5 text-[0.72rem] tracking-[0.1em]",
  md: "px-4 py-2 text-[0.82rem] tracking-[0.1em]",
  // Square, for a single glyph. No tracking — there is nothing to track.
  icon: "h-8 w-8 shrink-0 p-0 text-[0.9rem]",
} satisfies Readonly<Record<ButtonSize, string>>;

export type ButtonProps = SafeProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export default function Button(props: ButtonProps) {
  const [own, rest] = splitProps(props, ["variant", "size", "class", "onClick"]);

  /**
   * `aria-disabled` has to mean it.
   *
   * The attribute only tells assistive technology the control is unavailable —
   * the browser still fires the click, because that is the whole reason to
   * choose it over `disabled` (the control keeps its tab stop, so its reason
   * stays reachable). Swallowing the click here is what makes the announcement
   * true; leaving it to every caller makes the styling a promise the component
   * does not keep.
   */
  const inert = () => props["aria-disabled"] === true || props["aria-disabled"] === "true";

  return (
    // `type` sits before the spread so a caller can still pass `type="submit"`.
    // A button with no type submits the form it is in, which is never what a
    // toolbar control in a settings form means to do.
    <button
      type="button"
      {...rest}
      class={`${BASE} ${VARIANT[own.variant ?? "quiet"]} ${SIZE[own.size ?? "md"]}${
        own.class ? ` ${own.class}` : ""
      }`}
      onClick={(event) => {
        if (inert()) {
          // `preventDefault` as well as the early return: a `type="submit"`
          // button inside a form would otherwise still submit it.
          event.preventDefault();
          return;
        }
        const handler = own.onClick;
        if (typeof handler === "function") handler(event);
        // Solid's bound form: `onClick={[fn, data]}`.
        else if (Array.isArray(handler)) handler[0](handler[1], event);
      }}
    />
  );
}
