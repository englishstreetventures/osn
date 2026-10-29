// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { Chip } from "../../src/ui/chip";

/**
 * `Chip` gaining variants must not move the chips the portals already draw, so
 * this reads the default class list by name, as `notice.test.tsx` does: a
 * different string is a different chip. The browser tier
 * (`primitives.browser.test.tsx`) checks the same default by its computed look.
 */

afterEach(cleanup);

const BASE =
  "base:font-ui-body base:inline-flex base:shrink-0 base:items-center base:rounded-ui-pill " +
  "base:px-2.5 base:py-0.5 base:text-ui-xs base:tracking-ui-wider base:whitespace-nowrap base:uppercase";

/** Each tone's classes as they were before `Chip` had variants. */
const TODAY = {
  neutral: `${BASE} base:bg-ui-surface/60 base:text-ui-ink-secondary`,
  success: `${BASE} base:bg-ui-success/12 base:text-ui-success`,
  pending: `${BASE} base:bg-ui-warn/12 base:text-ui-warn`,
  accent: `${BASE} base:bg-ui-accent-soft base:text-ui-accent-ink`,
} as const;

describe("Chip's default", () => {
  it.each(["neutral", "success", "pending", "accent"] as const)(
    "renders the %s classes it rendered before",
    (tone) => {
      const { container } = render(() => <Chip tone={tone}>live</Chip>);
      expect(container.firstElementChild?.getAttribute("class")).toBe(TODAY[tone]);
    },
  );

  it("is `neutral` with no tone, and appends a caller's class last", () => {
    const { container } = render(() => <Chip class="mt-1">draft</Chip>);
    expect(container.firstElementChild?.getAttribute("class")).toBe(`${TODAY.neutral} mt-1`);
  });
});

describe("Chip's props", () => {
  it("leaves a badge's explanation to a Tooltip, not a title", () => {
    // A type check: `bun run typecheck` fails if `title` becomes a prop. The
    // browser test "drops a title a caller spreads" holds it at run time.
    // @ts-expect-error — a badge explains itself in a Tooltip.
    void (<Chip title="Owners can change anything">Owner</Chip>);
    expect(true).toBe(true);
  });
});
