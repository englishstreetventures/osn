import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  contrastOklch,
  type Oklch,
  oklchToRgb,
  parseColor,
  rgbToOklch,
  WCAG_TEXT_MIN,
  WCAG_UI_MIN,
} from "@cire/theme";
import { describe, expect, it } from "vitest";

/**
 * The contrast contract for the two ramps in `global.css`.
 *
 * This is a drift guard, not a design tool. Every ratio here passed when the
 * ramps were tuned; the test exists so that nudging one lightness value to make
 * a card look right cannot silently push muted text under 4.5:1 six months
 * later. It parses the stylesheet rather than a duplicated table of colours,
 * because a duplicated table is the thing that drifts.
 *
 * Two things a naive check gets wrong, and this one does not:
 *
 * - **Alpha.** `contrastOklch` ignores it by design (a translucent colour over an
 *   unknown backdrop has no single ratio). Half the ink tokens are translucent,
 *   so each is composited over its actual ground before measuring.
 * - **What has a contract at all.** `gold` is metal — rules, ornament, a seal —
 *   and is deliberately absent below. `gold-ink` is the readable variant and is
 *   asserted. Likewise `brand-hi` is a hover *fill*, so what is asserted is
 *   `on-brand` sitting on it, not it sitting on the page.
 */

const CSS = readFileSync(fileURLToPath(new URL("./global.css", import.meta.url)), "utf8");

/** The text between a selector's braces, found by counting them. */
function blockBody(selector: string): string {
  const at = CSS.indexOf(selector);
  if (at === -1) throw new Error(`no block for \`${selector}\` in global.css`);
  const open = CSS.indexOf("{", at + selector.length);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) return CSS.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after \`${selector}\``);
}

/**
 * The colour tokens of one ramp.
 *
 * Only `oklch()` values — `--inner-lip` and the two `--elev-*` shadows are
 * composite values with a colour inside them, not colours, and nothing below
 * measures them.
 */
function ramp(selector: string): Map<string, Oklch> {
  const out = new Map<string, Oklch>();
  for (const [, name, value] of blockBody(selector).matchAll(
    /--([\w-]+):\s*(oklch\([^)]*\))\s*;/g,
  )) {
    const parsed = parseColor(value);
    if (!parsed) throw new Error(`unparseable token --${name}: ${value}`);
    out.set(name, parsed);
  }
  return out;
}

// The dark ramp is the only `:root` block carrying `color-scheme: dark` — the
// other bare `:root` in the file holds the motion tokens.
const DARK = ramp(":root {\n  color-scheme: dark;");
const LIGHT = ramp(':root[data-theme="light"]');
const LIGHT_SYSTEM = ramp(":root:not([data-theme])");

/**
 * Composite a translucent colour over an opaque ground, in sRGB.
 *
 * sRGB and not OKLCH because that is what a browser does: `color-mix` aside,
 * alpha compositing happens in the device space after conversion.
 */
function over(fg: Oklch, bg: Oklch): Oklch {
  const f = oklchToRgb(fg);
  const b = oklchToRgb(bg);
  const a = fg.a;
  return rgbToOklch({
    r: a * f.r + (1 - a) * b.r,
    g: a * f.g + (1 - a) * b.g,
    b: a * f.b + (1 - a) * b.b,
  });
}

function ratio(tokens: Map<string, Oklch>, fg: string, bg: string): number {
  const f = tokens.get(fg);
  const b = tokens.get(bg);
  if (!f) throw new Error(`missing token --${fg}`);
  if (!b) throw new Error(`missing token --${bg}`);
  return contrastOklch(f.a < 1 ? over(f, b) : f, b);
}

/** Readable text: 4.5:1. */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surface-raised"],
  ["text", "surface-sunk"],
  ["text-muted", "bg"],
  ["text-muted", "surface"],
  ["text-muted", "surface-raised"],
  ["brand-ink", "bg"],
  ["brand-ink", "surface"],
  ["gold-ink", "bg"],
  ["gold-ink", "surface"],
  ["on-brand", "brand"],
  ["success", "bg"],
  ["warn", "bg"],
  ["error", "bg"],
  ["success", "surface"],
  ["warn", "surface"],
  ["error", "surface"],
];

/** Large text, ornament, control boundaries, focus indicators: 3:1. */
const UI_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["text-faint", "bg"],
  ["text-faint", "surface"],
  ["border-strong", "bg"],
  ["border-strong", "surface"],
  ["focus", "bg"],
  ["focus", "surface"],
  ["on-brand", "brand-hi"],
];

const RAMPS: ReadonlyArray<readonly [string, Map<string, Oklch>]> = [
  ["dark", DARK],
  ["light", LIGHT],
];

describe.each(RAMPS)("%s ramp", (_name, tokens) => {
  it.each(TEXT_PAIRS)("--%s on --%s clears 4.5:1", (fg, bg) => {
    expect(ratio(tokens, fg, bg)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  });

  it.each(UI_PAIRS)("--%s on --%s clears 3:1", (fg, bg) => {
    expect(ratio(tokens, fg, bg)).toBeGreaterThanOrEqual(WCAG_UI_MIN);
  });
});

describe("ramp shape", () => {
  it("declares the same tokens in both ramps", () => {
    // A token defined in dark and forgotten in light does not fail loudly — it
    // silently keeps the dark value, which is how a light mode ends up with one
    // black card in it.
    expect(new Set(LIGHT.keys())).toEqual(new Set(DARK.keys()));
  });

  it("keeps the system-preference light block identical to the explicit one", () => {
    // The `@media (prefers-color-scheme: light)` copy exists so a document with
    // no JavaScript still gets light. The two are hand-duplicated, so assert
    // they have not drifted apart.
    expect([...LIGHT_SYSTEM].map(([k, v]) => [k, v])).toEqual([...LIGHT].map(([k, v]) => [k, v]));
  });

  it("emits the aliases whether or not a utility uses them", () => {
    // Tailwind only emits the theme variables it sees a utility using, and it
    // reads source as text — so a token spelled only inside a `style={{ … }}`
    // object is invisible to it. `static` emits the block regardless. Without
    // it the invite preview's `var(--color-gold)` resolves to nothing the
    // moment the last `text-gold` class leaves the package, with every test
    // still green.
    expect(CSS).toContain("@theme static {");
  });

  it("gives every ramp a whole set of grounds and ink", () => {
    for (const key of [
      "bg",
      "bg-deep",
      "surface",
      "surface-raised",
      "surface-sunk",
      "text",
      "brand",
      "focus",
    ]) {
      expect(DARK.has(key)).toBe(true);
    }
  });
});
