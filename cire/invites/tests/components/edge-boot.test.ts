import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bottomIsHero,
  decideEdges,
  EDGE_BOOT_SCRIPT,
  EDGE_BOTTOM_CLASS,
  EDGE_TOP_CLASS,
  edgeStyle,
  oklchToHex,
  parseInsetPx,
  serverEdgeColours,
} from "../../src/components/edge-boot";

describe("parseInsetPx", () => {
  it("reads a positive px value", () => {
    expect(parseInsetPx("34px")).toBe(34);
    expect(parseInsetPx("21.5px")).toBe(21.5);
  });

  it("reads anything that is not a positive number as 0", () => {
    expect(parseInsetPx("")).toBe(0);
    expect(parseInsetPx("0px")).toBe(0);
    expect(parseInsetPx("NaN")).toBe(0);
    expect(parseInsetPx("auto")).toBe(0);
    expect(parseInsetPx("env(safe-area-inset-top)")).toBe(0);
  });
});

describe("decideEdges", () => {
  it("turns each edge on from its own inset", () => {
    expect(decideEdges(34, 0)).toEqual({ top: true, bottom: false });
    expect(decideEdges(0, 34)).toEqual({ top: false, bottom: true });
    expect(decideEdges(34, 34)).toEqual({ top: true, bottom: true });
    expect(decideEdges(0, 0)).toEqual({ top: false, bottom: false });
  });
});

describe("bottomIsHero", () => {
  // A hero exactly one viewport tall: its bottom is innerHeight − scrollY.
  const innerHeight = 844;
  const heroBottomAt = (scrollY: number) => innerHeight - scrollY;

  it.each([12, 34])(
    "keeps the hero colour until scroll reaches the strip height (%i px)",
    (strip) => {
      expect(bottomIsHero(heroBottomAt(0), innerHeight, strip)).toBe(true);
      expect(bottomIsHero(heroBottomAt(strip - 1), innerHeight, strip)).toBe(true);
      expect(bottomIsHero(heroBottomAt(strip), innerHeight, strip)).toBe(false);
    },
  );
});

describe("edgeStyle", () => {
  it("writes both edge colours as declarations", () => {
    expect(edgeStyle({ top: "#0d1f17", bottom: "#112233" })).toBe(
      "--edge-top-bg:#0d1f17;--edge-bottom-bg:#112233",
    );
  });

  it("falls back to a constant for anything that is not six-digit hex", () => {
    expect(edgeStyle({ top: "oklch(20% 0.03 150)", bottom: "#fff" })).toBe(
      "--edge-top-bg:#000000;--edge-bottom-bg:#000000",
    );
  });

  it("cannot be broken out of by a value that carries a declaration", () => {
    const out = edgeStyle({ top: "#000000;background:red", bottom: "#000000" });
    expect(out).not.toContain("background:red");
    expect(out.split(";")).toHaveLength(2);
  });
});

describe("oklchToHex", () => {
  it("converts the ends of the lightness scale", () => {
    expect(oklchToHex("oklch(0% 0 0)")).toBe("#000000");
    expect(oklchToHex("oklch(100% 0 0)")).toBe("#ffffff");
  });

  it("passes a hex value through unchanged", () => {
    expect(oklchToHex("#0d1f17")).toBe("#0d1f17");
  });

  it("returns null for a value it cannot read", () => {
    expect(oklchToHex("")).toBeNull();
    expect(oklchToHex("not-a-colour")).toBeNull();
  });
});

describe("EDGE_BOOT_SCRIPT", () => {
  afterEach(() => {
    document.documentElement.classList.remove(EDGE_TOP_CLASS, EDGE_BOTTOM_CLASS);
    vi.unstubAllGlobals();
  });

  // The script is what runs before first paint, so run the string itself
  // against a stubbed probe padding, rather than trusting a copy of its logic.
  const run = (paddingTop: string, paddingBottom: string) => {
    vi.stubGlobal("getComputedStyle", () => ({ paddingTop, paddingBottom }));
    // eslint-disable-next-line no-eval
    (0, eval)(EDGE_BOOT_SCRIPT);
    return document.documentElement.classList;
  };

  it("sets both classes when both insets are non-zero", () => {
    const cls = run("34px", "34px");
    expect(cls.contains(EDGE_TOP_CLASS)).toBe(true);
    expect(cls.contains(EDGE_BOTTOM_CLASS)).toBe(true);
  });

  it("sets only the class for an edge that has an inset", () => {
    const cls = run("0px", "21px");
    expect(cls.contains(EDGE_TOP_CLASS)).toBe(false);
    expect(cls.contains(EDGE_BOTTOM_CLASS)).toBe(true);
  });

  it("sets neither class when the insets read as nothing", () => {
    const cls = run("", "NaN");
    expect(cls.contains(EDGE_TOP_CLASS)).toBe(false);
    expect(cls.contains(EDGE_BOTTOM_CLASS)).toBe(false);
  });

  it("removes its probe element", () => {
    run("34px", "0px");
    expect(
      document.documentElement.querySelector('[aria-hidden="true"][style*="env("]'),
    ).toBeNull();
  });
});

describe("serverEdgeColours", () => {
  const palette = {
    "--color-bg": "oklch(19.96% 0.0331 147.34)",
    "--invite-hero-grad-1": "oklch(27.7% 0.0275 152.78)",
    "--invite-hero-grad-3": "oklch(22.7% 0.0275 152.78)",
  };

  it("uses the hero colours at the top and bottom when a hero is shown", () => {
    const c = serverEdgeColours(palette, true);
    expect(c.top).toBe(oklchToHex(palette["--invite-hero-grad-1"]));
    expect(c.bottom).toBe(oklchToHex(palette["--invite-hero-grad-3"]));
  });

  it("uses the page colour on both edges when no hero is shown", () => {
    const page = oklchToHex(palette["--color-bg"]);
    expect(serverEdgeColours(palette, false)).toEqual({ top: page, bottom: page });
  });
});
