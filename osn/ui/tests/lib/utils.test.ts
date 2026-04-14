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

describe("bx()", () => {
  it("prefixes each utility class with base:", () => {
    expect(bx("bg-card rounded-xl border")).toBe("base:bg-card base:rounded-xl base:border");
  });

  it("handles variant-prefixed classes correctly", () => {
    expect(bx("hover:bg-muted focus:ring-2")).toBe("base:hover:bg-muted base:focus:ring-2");
  });

  it("handles data-attribute selectors", () => {
    expect(bx("data-[selected]:bg-primary")).toBe("base:data-[selected]:bg-primary");
  });

  it("handles arbitrary value classes", () => {
    expect(bx("text-[10px] min-h-[60px]")).toBe("base:text-[10px] base:min-h-[60px]");
  });

  it("handles single class", () => {
    expect(bx("flex")).toBe("base:flex");
  });

  it("handles empty string", () => {
    expect(bx("")).toBe("");
  });
});
