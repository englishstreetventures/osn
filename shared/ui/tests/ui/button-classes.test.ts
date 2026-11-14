import { describe, expect, it } from "vitest";

import { buttonVariants } from "../../src/ui/button";

/**
 * The classes every existing (variant, size) pair of `Button` carries, held as
 * the pieces the code before `size="inline"` and `busy` composed them from: one
 * base string, one string per variant and one per size.
 *
 * pulse, musubi, `@osn/auth-ui` and the lab draw these buttons, and links that
 * wear `buttonVariants` draw them too. `button-default.browser.test.tsx` holds
 * the computed look of each variant at the default size and each size at the
 * default variant; this file holds the class set of all twenty-eight pairs, so
 * a pair neither of those reaches, such as `link` at `sm`, cannot change
 * unseen when classes move between the base, the variants, the sizes and the
 * compound variants. Order and repeats are not held: neither changes the CSS.
 *
 * One class has gone on purpose: `sm` no longer carries the base string's
 * `text-ui-base`, which its own `text-ui-sm` overrode only by coming later in
 * Tailwind's output. Its computed size, 13px, is held by the snapshot in
 * `button-default.browser.test.tsx`.
 *
 * And the press changed two things on purpose: the base string's
 * `transition-colors` became the three transition longhands that add `scale`
 * to the same colour fade, and every pair carries the press class, since every
 * size here draws a box (`button-press.browser.test.tsx` holds what they do).
 */

const BASE =
  "base:inline-flex base:cursor-pointer base:items-center base:justify-center base:gap-2 base:whitespace-nowrap base:rounded-ui-control base:text-ui-base base:font-medium base:transition-colors base:focus-visible:outline-hidden base:focus-visible:ring-2 base:focus-visible:ring-ui-focus base:disabled:pointer-events-none base:disabled:opacity-50";

const VARIANTS = {
  default: "base:bg-ui-accent base:text-ui-on-accent base:hover:bg-ui-accent/90",
  destructive: "base:bg-ui-danger base:text-ui-on-danger base:hover:bg-ui-danger/90",
  outline:
    "base:border base:border-ui-hairline-strong base:bg-ui-ground base:hover:bg-ui-surface-sunk base:hover:text-ui-ink",
  secondary: "base:bg-ui-surface-sunk base:text-ui-ink base:hover:bg-ui-surface-sunk/80",
  ghost: "base:hover:bg-ui-surface-sunk base:hover:text-ui-ink",
  ghostDanger: "base:text-ui-ink-secondary base:hover:bg-ui-surface-sunk base:hover:text-ui-danger",
  link: "base:text-ui-accent-ink base:underline-offset-4 base:hover:underline",
} as const;

const SIZES = {
  default: "base:h-9 base:px-4 base:py-2",
  sm: "base:h-8 base:rounded-ui-control base:px-3 base:text-ui-sm",
  lg: "base:h-10 base:rounded-ui-control base:px-8",
  icon: "base:h-9 base:w-9",
} as const;

type Variant = keyof typeof VARIANTS;
type Size = keyof typeof SIZES;

/** The distinct classes in `strings`. */
const classSet = (...strings: string[]) => new Set(strings.join(" ").split(/\s+/).filter(Boolean));

/** The colour fade with `scale` on the press tokens, in place of `transition-colors`. */
const TRANSITION = [
  "base:[transition-property:color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to,scale]",
  `base:[transition-duration:${"var(--default-transition-duration),".repeat(10)}var(--ui-dur-fast)]`,
  `base:[transition-timing-function:${"var(--default-transition-timing-function),".repeat(10)}var(--ui-ease-out)]`,
];

const PRESS = "base:motion-safe:active:not-disabled:not-aria-disabled:scale-97";

/**
 * What a pair carries now: what it carried before, less `sm`'s overridden
 * step, with the press's transition in place of `transition-colors` and the
 * press itself.
 */
const expected = (variant: Variant, size: Size) => {
  const set = classSet(BASE, VARIANTS[variant], SIZES[size]);
  if (size === "sm") set.delete("base:text-ui-base");
  set.delete("base:transition-colors");
  for (const name of [...TRANSITION, PRESS]) set.add(name);
  return set;
};

const PAIRS = (Object.keys(VARIANTS) as Variant[]).flatMap((variant) =>
  (Object.keys(SIZES) as Size[]).map((size) => ({ variant, size })),
);

describe("buttonVariants for every existing pair", () => {
  it.each(PAIRS)("$variant at $size carries the classes it carried before", ({ variant, size }) => {
    expect(classSet(buttonVariants({ variant, size }))).toEqual(expected(variant, size));
  });

  it("with nothing passed, carries the default variant at the default size", () => {
    expect(classSet(buttonVariants())).toEqual(expected("default", "default"));
  });

  it("with only a variant, carries it at the default size", () => {
    expect(classSet(buttonVariants({ variant: "link" }))).toEqual(expected("link", "default"));
  });
});
