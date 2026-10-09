import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { HeroFallbackTitle } from "../../src/components/HeroFallbackTitle";
import {
  HERO_FALLBACK_TITLE,
  setReturningHousehold,
  WELCOME_BACK,
} from "../../src/components/returning-household";

afterEach(() => {
  cleanup();
  // Module state outlives each case; put it back.
  setReturningHousehold(false);
});

/** What a screen reader can reach: text outside every `aria-hidden` subtree. */
const READABLE = { ignore: "[aria-hidden='true']" };

const slots = () => ({
  firstVisit: screen.getByText(HERO_FALLBACK_TITLE),
  welcome: screen.getByText(WELCOME_BACK),
});

/**
 * The wiring and class contract. That the two strings share one cell sized by
 * the taller, where the shorter sits in it, and that the swap moves nothing
 * are layout facts jsdom cannot compute; `tests/designs/InviteHeader.browser.test.tsx`
 * measures those in both packs.
 */
describe("HeroFallbackTitle", () => {
  it("holds both strings in one cell, and a reader reaches only the first-visit one", () => {
    const { container } = render(() => (
      <HeroFallbackTitle align="center" class="text-center select-none" />
    ));
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["grid", "grid-cols-1", "items-center", "text-center", "select-none"]),
    );

    const { firstVisit, welcome } = slots();
    for (const slot of [firstVisit, welcome]) {
      expect(slot.parentElement).toBe(cell);
      expect(slot.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["col-start-1", "row-start-1"]),
      );
    }
    expect(firstVisit.className).not.toContain("invisible");
    expect(firstVisit.hasAttribute("aria-hidden")).toBe(false);
    expect(welcome.className.split(/\s+/)).toContain("invisible");
    expect(welcome.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText(WELCOME_BACK, READABLE)).toBeNull();
  });

  it("puts the shorter string on the cell's bottom edge for a pack anchored to the foot", () => {
    const { container } = render(() => <HeroFallbackTitle align="end" class="" />);
    expect((container.firstElementChild as HTMLElement).className.split(/\s+/)).toContain(
      "items-end",
    );
  });

  it("turns to the welcome-back string for a returning household, and back on sign-out", () => {
    render(() => <HeroFallbackTitle align="center" class="" />);

    setReturningHousehold(true);
    let { firstVisit, welcome } = slots();
    expect(screen.getByText(WELCOME_BACK, READABLE)).toBe(welcome);
    expect(screen.queryByText(HERO_FALLBACK_TITLE, READABLE)).toBeNull();
    expect(welcome.className).not.toContain("invisible");
    expect(firstVisit.className.split(/\s+/)).toContain("invisible");

    setReturningHousehold(false);
    ({ firstVisit, welcome } = slots());
    expect(screen.getByText(HERO_FALLBACK_TITLE, READABLE)).toBe(firstVisit);
    expect(screen.queryByText(WELCOME_BACK, READABLE)).toBeNull();
    expect(welcome.className.split(/\s+/)).toContain("invisible");
  });
});
