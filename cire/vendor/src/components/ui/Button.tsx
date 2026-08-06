import { splitProps } from "solid-js";

import type { SafeProps } from "./props";

/**
 * The portal's button.
 *
 * Same four shapes and same class strings as the host portal's, on purpose: a
 * vendor who also hosts a wedding should not find "save" a different size on the
 * two sites. Before this, every control here was written out longhand — which is
 * why the claim page's primary was an *outline* button with a hover fill, the
 * listing form's was solid gold, and the sign-in page's was solid gold with a
 * different radius, a different tracking and `hover:opacity-90` instead of a
 * hover colour.
 *
 * ## No haptic here
 *
 * Tempting, and wrong. The vocabulary in `haptics.ts` is three names, fired at
 * the moment a change *takes* — not at the moment a button is pressed. A press
 * that opens a dialog, switches a view or starts a request that then fails has
 * nothing to confirm yet.
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
  "disabled:pointer-events-none disabled:opacity-40";

const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary: "border-gold bg-gold text-bg hover:bg-gold-dim",
  outline: "border-gold/40 text-gold hover:border-gold hover:bg-gold/10",
  quiet: "border-border text-text-muted hover:border-gold hover:text-gold",
  danger: "border-error/40 text-error hover:border-error hover:bg-error/10",
};

const SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: "px-3 py-1.5 text-[0.72rem] tracking-[0.1em]",
  md: "px-4 py-2 text-[0.82rem] tracking-[0.1em]",
  // Square, for a single glyph. No tracking — there is nothing to track.
  icon: "h-8 w-8 shrink-0 p-0 text-[0.9rem]",
};

/**
 * The classes on their own, for a control that has to be an `<a>`.
 *
 * Two of them are: "create one in musubi" on the empty org list, and "account &
 * passkeys" in the profile menu. Both leave the origin, and only a real anchor
 * gets a middle-click, a "copy link address" and a status-bar preview of where
 * it goes — so they cannot be `<button onClick={() => location.assign(…)}>`.
 * Exported rather than duplicated for the same reason `cardClass` is: Tailwind
 * scans source as text, so a literal inside a function is a literal it finds.
 */
export function buttonClass(options: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
  return `${BASE} ${VARIANT[options.variant ?? "quiet"]} ${SIZE[options.size ?? "md"]}`;
}

export type ButtonProps = SafeProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export default function Button(props: ButtonProps) {
  const [own, rest] = splitProps(props, ["variant", "size", "class"]);
  return (
    // `type` sits before the spread so a caller can still pass `type="submit"`.
    // A button with no type submits the form it is in, which is never what a
    // toolbar control inside the listing form means to do.
    <button
      type="button"
      {...rest}
      class={`${buttonClass({ variant: own.variant, size: own.size })}${
        own.class ? ` ${own.class}` : ""
      }`}
    />
  );
}
