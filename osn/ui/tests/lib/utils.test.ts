import { describe, it, expect } from "vitest";

import { bx, cn } from "../../src/lib/utils";

describe("cn()", () => {
  it("joins plain class strings", () => {
    expect(cn("px-4", "py-2")).toBe("px-4 py-2");
  });

  it("filters out falsy values", () => {
    const showHidden = false;
    expect(cn("px-4", showHidden && "hidden", null, undefined, "py-2")).toBe("px-4 py-2");
  });

  it("resolves Tailwind conflicts (last wins)", () => {
    // tailwind-merge should drop px-4 in favour of px-2
    expect(cn("px-4 py-2", "px-2")).toBe("py-2 px-2");
  });

  it("handles conditional objects via clsx", () => {
    expect(cn("base", { hidden: true, flex: false })).toBe("base hidden");
  });

  it("returns empty string for no inputs", () => {
    expect(cn()).toBe("");
  });

  it("deduplicates identical classes via tailwind-merge", () => {
    expect(cn("rounded-md", "rounded-md")).toBe("rounded-md");
  });

  it("resolves size conflicts (rounded-md vs rounded-xl)", () => {
    expect(cn("rounded-md", "rounded-xl")).toBe("rounded-xl");
  });
});

describe("bx() — deprecated identity function", () => {
  it("returns input unchanged (identity)", () => {
    expect(bx("bg-card rounded-xl border")).toBe("bg-card rounded-xl border");
  });

  it("passes through variant-prefixed classes", () => {
    expect(bx("hover:bg-muted focus:ring-2")).toBe("hover:bg-muted focus:ring-2");
  });

  it("passes through base:-prefixed classes", () => {
    expect(bx("base:bg-card base:rounded-xl")).toBe("base:bg-card base:rounded-xl");
  });

  it("handles empty string", () => {
    expect(bx("")).toBe("");
  });
});
