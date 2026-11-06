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

const PAIRS = (Object.keys(VARIANTS) as Variant[]).flatMap((variant) =>
  (Object.keys(SIZES) as Size[]).map((size) => ({ variant, size })),
);

describe("buttonVariants for every existing pair", () => {
  it.each(PAIRS)("$variant at $size carries the classes it carried before", ({ variant, size }) => {
    expect(classSet(buttonVariants({ variant, size }))).toEqual(
      classSet(BASE, VARIANTS[variant], SIZES[size]),
    );
  });

  it("with nothing passed, carries the default variant at the default size", () => {
    expect(classSet(buttonVariants())).toEqual(classSet(BASE, VARIANTS.default, SIZES.default));
  });

  it("with only a variant, carries it at the default size", () => {
    expect(classSet(buttonVariants({ variant: "link" }))).toEqual(
      classSet(BASE, VARIANTS.link, SIZES.default),
    );
  });
});
