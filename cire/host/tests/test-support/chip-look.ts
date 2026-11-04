/**
 * How a `@shared/ui` `Chip` was drawn, read back from its classes: the tone,
 * the variant and the treatment its call site picked. The three are the call
 * site's whole say over a chip's look, so a test reads them here rather than
 * matching a class string that a change to `chip.tsx` would rewrite.
 *
 * Outlined is the `base:border` class; filled is a `base:bg-ui-*` ground and no
 * border. The tone is the ink, and small caps are `base:uppercase`. A class
 * list that is neither variant, or has no known ink, reads as `null`, so a
 * span that is not a chip at all fails the comparison rather than passing it.
 *
 * No test framework here: the browser project imports it as well.
 */

export interface ChipLook {
  tone: "neutral" | "success" | "pending" | "accent" | "danger" | null;
  variant: "filled" | "outline" | null;
  treatment: "caps" | "tag";
}

const INK: Readonly<Record<string, NonNullable<ChipLook["tone"]>>> = {
  "base:text-ui-ink-secondary": "neutral",
  "base:text-ui-success": "success",
  "base:text-ui-warn": "pending",
  "base:text-ui-accent-ink": "accent",
  "base:text-ui-danger": "danger",
};

export function chipLook(el: Element): ChipLook {
  const classes = [...el.classList];
  const outline = classes.includes("base:border");
  const ground = classes.some((c) => c.startsWith("base:bg-ui-"));
  const ink = classes.find((c) => Object.hasOwn(INK, c));
  return {
    tone: ink === undefined ? null : INK[ink]!,
    variant: outline ? "outline" : ground ? "filled" : null,
    treatment: classes.some((c) => c.endsWith("uppercase")) ? "caps" : "tag",
  };
}
