import { describe, it, expect } from "vitest";

import { clsx } from "../../src/lib/utils";

describe("clsx()", () => {
  it("joins plain class strings", () => {
    expect(clsx("px-4", "py-2")).toBe("px-4 py-2");
  });

  it("filters out falsy values", () => {
    const showHidden = false;
    expect(clsx("px-4", showHidden && "hidden", null, undefined, "py-2")).toBe("px-4 py-2");
  });

  it("handles conditional objects", () => {
    expect(clsx("base", { hidden: true, flex: false })).toBe("base hidden");
  });

  it("returns empty string for no inputs", () => {
    expect(clsx()).toBe("");
  });

  it("does no conflict resolution: both conflicting utilities stay in the string", () => {
    // Which of the two applies is up to the stylesheet, not this function.
    // Components avoid the question with `base:` defaults, which lose to any
    // unprefixed utility a caller passes.
    expect(clsx("px-4", "px-2")).toBe("px-4 px-2");
  });
});
