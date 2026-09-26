import { describe, expect, it } from "bun:test";

import { isVisibilitySection, sectionState, VISIBILITY_SECTIONS } from "../src/index";

/**
 * The switch vocabulary the API, the organiser builder and the guest site all
 * read. The builder's badge and the guest render decide from the same function,
 * so these cases are the contract both sides are held to.
 */
describe("sectionState", () => {
  it("is shown when switched on and the section has content", () => {
    expect(sectionState(true, false)).toBe("shown");
  });

  it("is off when switched off, whether or not the section has content", () => {
    expect(sectionState(false, false)).toBe("off");
    expect(sectionState(false, true)).toBe("off");
  });

  it("is empty when switched on but the section has no content", () => {
    expect(sectionState(true, true)).toBe("empty");
  });

  // A payload from an API older than the switches carries no flag. It has to
  // render as it did before the switches existed, where a section with content
  // always showed — reading "absent" as off would hide every such section.
  it("reads an absent switch as on", () => {
    expect(sectionState(undefined, false)).toBe("shown");
    expect(sectionState(null, false)).toBe("shown");
    expect(sectionState(undefined, true)).toBe("empty");
  });
});

describe("VISIBILITY_SECTIONS", () => {
  // The closed set. Welcome (the code entry) and Events cannot be switched
  // off: a guest needs both to reach their invitation.
  it("names the hero, Our Story, the FAQ and the closing section, in scroll order", () => {
    expect([...VISIBILITY_SECTIONS]).toEqual(["hero", "story", "faq", "footer"]);
  });

  it("accepts its own members and nothing else", () => {
    for (const section of VISIBILITY_SECTIONS) expect(isVisibilitySection(section)).toBe(true);
    for (const other of ["welcome", "details", "registry", "Hero", "", "closing"]) {
      expect(isVisibilitySection(other)).toBe(false);
    }
  });
});
