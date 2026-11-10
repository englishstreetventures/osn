/**
 * `Badge`'s weight in real Chromium: the label reads `--ui-weight-title`, the
 * contract's title weight, and falls back to 600 where no app sets it.
 *
 * A DOM shim can see that the class is there; only a stylesheet can show that
 * Tailwind built a rule for it, that the rule won, and that the token is read
 * at the badge rather than once at the root, so a subtree that sets it is
 * followed. Every variant runs in both treatments, since the eyebrow treatment
 * is pulse's category pill and must not set a weight of its own.
 *
 * The frozen look of the unset case, every computed style and not just the
 * weight, is held apart in `badge-default.browser.test.tsx`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { Badge, type BadgeProps } from "../src/ui/badge";

import "./test-support/tailwind.css";

type Variant = NonNullable<BadgeProps["variant"]>;
type Treatment = NonNullable<BadgeProps["treatment"]>;

const VARIANTS = Object.keys({
  default: 1,
  secondary: 1,
  destructive: 1,
  outline: 1,
} satisfies Record<Variant, 1>) as Variant[];
const TREATMENTS = Object.keys({ default: 1, eyebrow: 1 } satisfies Record<
  Treatment,
  1
>) as Treatment[];

const CASES = VARIANTS.flatMap((variant) =>
  TREATMENTS.map((treatment) => ({ variant, treatment })),
);

afterEach(() => {
  cleanup();
});

/** Every variant in every treatment, each with a label, under one parent. */
function AllBadges(props: { testId: string; style?: string }) {
  return (
    <div data-testid={props.testId} style={props.style} class="flex flex-col gap-2 p-3">
      {CASES.map(({ variant, treatment }) => (
        <Badge variant={variant} treatment={treatment}>
          {variant} {treatment}
        </Badge>
      ))}
    </div>
  );
}

function weights(parent: HTMLElement): string[] {
  return Array.from(parent.children, (badge) => getComputedStyle(badge).fontWeight);
}

describe("Badge's weight", () => {
  it("is 600 with no token set, and follows `--ui-weight-title` set on an ancestor, in every variant and treatment", async () => {
    render(() => (
      <div data-testid="frame" class="flex gap-6">
        <AllBadges testId="unset" />
        <AllBadges testId="mapped" style="--ui-weight-title: 500" />
      </div>
    ));
    const mapped = screen.getByTestId("mapped");
    expect(mapped.children).toHaveLength(CASES.length);
    expect(weights(mapped)).toEqual(CASES.map(() => "500"));
    expect(weights(screen.getByTestId("unset"))).toEqual(CASES.map(() => "600"));
    await page.screenshot({
      path: "__screenshots__/badge.browser.test.tsx/weight-unset-and-500.png",
      element: screen.getByTestId("frame"),
    });
  });
});
