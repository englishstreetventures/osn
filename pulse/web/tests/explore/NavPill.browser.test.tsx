/**
 * Does `bg-pulse-accent` actually paint the coral?
 *
 * The utility exists only because `app.css`'s `@theme inline` block now names
 * `--color-pulse-accent`. If that entry is dropped or renamed, Tailwind emits
 * **no rule at all** — no error, no warning — and `NavPill` renders a
 * transparent pill with unreadable text while every string-level assertion
 * about its class list still passes. This is the tier that can tell.
 *
 * It matters more than the usual case of that rule, because the alternative the
 * component replaced was an inline `style`, which cannot silently fail. Moving
 * to a utility is only an improvement while the utility resolves.
 */

import { render } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import "../../src/app.css";
import { NavPill } from "../../src/explore/NavPill";

/** Paint a value and read it back, so an `oklch()` and a `var()` chain compare. */
function paint(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

beforeAll(() => {
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("NavPill, painted", () => {
  it("fills the accent tone with the coral brand colour", () => {
    const { getByRole } = render(() => <NavPill tone="accent">Host</NavPill>);
    const painted = getComputedStyle(getByRole("button")).backgroundColor;

    expect(painted).not.toBe("rgba(0, 0, 0, 0)");
    expect(painted).toBe(paint("var(--pulse-accent)"));
  });

  it("writes the accent label in the colour chosen to sit on it", () => {
    const { getByRole } = render(() => <NavPill tone="accent">Host</NavPill>);
    expect(getComputedStyle(getByRole("button")).color).toBe(paint("var(--pulse-accent-fg)"));
  });

  it("leaves the outline tone on the card ground, not the coral", () => {
    const { getByRole } = render(() => <NavPill tone="outline">Notifications</NavPill>);
    const painted = getComputedStyle(getByRole("button")).backgroundColor;

    expect(painted).toBe(paint("var(--card)"));
    expect(painted).not.toBe(paint("var(--pulse-accent)"));
  });

  it("gives both tones the same box, which is what made them one component", () => {
    const { getByRole: accent } = render(() => <NavPill tone="accent">A</NavPill>);
    const { getByRole: outline } = render(() => <NavPill tone="outline">A</NavPill>);

    // `offsetHeight`, not a rect: a rect is post-transform, and these carry a
    // hover transition that a future change could leave mid-flight.
    expect((accent("button") as HTMLElement).offsetHeight).toBe(
      (outline("button") as HTMLElement).offsetHeight,
    );
  });
});
