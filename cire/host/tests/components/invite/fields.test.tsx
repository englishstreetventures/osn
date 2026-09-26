// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import {
  FADED_LABEL,
  HiddenSectionIcon,
  isHiddenState,
  sectionTabTone,
} from "../../../src/components/invite/fields";

describe("isHiddenState", () => {
  it.each([
    [undefined, false],
    ["shown", false],
    ["empty", true],
    ["off", true],
  ] as const)("reads %s as hidden: %s", (state, hidden) => {
    expect(isHiddenState(state)).toBe(hidden);
  });
});

describe("sectionTabTone", () => {
  const tokens = (classes: string) => classes.split(/\s+/);
  const looks = [
    sectionTabTone(true, false),
    sectionTabTone(true, true),
    sectionTabTone(false, false),
    sectionTabTone(false, true),
  ];

  it("gives each of the four states its own look", () => {
    expect(new Set(looks).size).toBe(4);
  });

  it("puts the selection wash on the selected tabs only", () => {
    expect(tokens(sectionTabTone(true, false))).toContain("bg-gold/12");
    expect(tokens(sectionTabTone(true, true))).toContain("bg-gold/12");
    expect(tokens(sectionTabTone(false, false))).not.toContain("bg-gold/12");
    expect(tokens(sectionTabTone(false, true))).not.toContain("bg-gold/12");
  });

  it("paints a selected tab in the readable gold, not the metal", () => {
    // `gold` carries no contrast contract; `gold-ink` is the gold for text.
    for (const hidden of [false, true]) {
      expect(tokens(sectionTabTone(true, hidden))).not.toContain("text-gold");
    }
  });

  it("fades a hidden, unselected tab to the faded ink rather than the idle one", () => {
    expect(tokens(sectionTabTone(false, true))).toContain(FADED_LABEL);
    expect(tokens(sectionTabTone(false, true))).not.toContain("text-text-muted");
    expect(tokens(sectionTabTone(false, false))).not.toContain(FADED_LABEL);
  });
});

describe("HiddenSectionIcon", () => {
  afterEach(cleanup);

  it("draws an icon that assistive tech skips, in the label's own ink", () => {
    const { container } = render(() => <HiddenSectionIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("data-hidden-icon")).toBe(true);
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });
});
