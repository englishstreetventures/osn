/**
 * Parser coverage for the shared colour maths. Moved here from
 * `cire/organiser/src/lib/contrast.ts` when derivation became shared: the
 * organiser, the guest site and the API all read colours through this module
 * now, so its parser is the one that must be right.
 */
import { describe, expect, it } from "bun:test";

import { contrastRatio, parseCssColor, WCAG_TEXT_MIN } from "./color";

describe("parseCssColor", () => {
  it("parses hex (short + long, alpha ignored)", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseCssColor("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseCssColor("#ff000080")).toEqual({ r: 1, g: 0, b: 0 });
  });

  it("parses rgb()/rgba() with comma and space syntax", () => {
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseCssColor("rgba(0 255 0 / 0.5)")).toEqual({ r: 0, g: 1, b: 0 });
  });

  it("parses hsl() (red / white / black)", () => {
    const red = parseCssColor("hsl(0, 100%, 50%)")!;
    expect(red.r).toBeCloseTo(1);
    expect(red.g).toBeCloseTo(0);
    expect(parseCssColor("hsl(0, 0%, 100%)")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseCssColor("hsl(120deg, 0%, 0%)")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("parses oklch() (white and black limits)", () => {
    const white = parseCssColor("oklch(100% 0 0)")!;
    expect(white.r).toBeGreaterThan(0.99);
    const black = parseCssColor("oklch(0% 0 0)")!;
    expect(black.r).toBeLessThan(0.01);
  });

  it("returns null for anything unparseable (named colours, garbage)", () => {
    expect(parseCssColor("rebeccapurple")).toBeNull();
    expect(parseCssColor("var(--x)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for identical colours", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#123456", "#fedcba")).toBeCloseTo(
      contrastRatio("#fedcba", "#123456")!,
      10,
    );
  });

  it("works across formats (rgb vs hsl)", () => {
    expect(contrastRatio("rgb(255,255,255)", "hsl(0, 0%, 0%)")).toBeCloseTo(21, 1);
  });

  it("passes the built-in gold-on-surface defaults (no advisory out of the box)", () => {
    // The builder's advisory must NOT fire for an un-themed invite — pin the
    // default token pair (mirrors PREVIEW_DEFAULTS) comfortably above the AA
    // text minimum.
    const ratio = contrastRatio("oklch(74.99% 0.0854 82.08)", "oklch(22.7% 0.0275 152.78)");
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(WCAG_TEXT_MIN);
  });

  it("returns null when either colour is unparseable", () => {
    expect(contrastRatio("nope", "#fff")).toBeNull();
    expect(contrastRatio("#fff", "url(x)")).toBeNull();
  });
});
