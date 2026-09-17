import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { contrastOklch, cssRamp, type Oklch } from "@cire/theme";
import { checkContractConformance } from "@shared/design-tokens/conformance";
import { describe, expect, it } from "vitest";

/**
 * The contrast contract for the two ramps in `global.css`.
 *
 * A drift guard, not a design tool: it exists so that nudging one lightness to
 * make a card look right cannot silently push muted text under 4.5:1 six months
 * later. It reads the stylesheet rather than a table of colours copied into a
 * test, because a copied table is the thing that drifts.
 *
 * **Most of it is now `@shared/design-tokens`.** The hand-written pair table and
 * the alpha-compositing machinery under it moved into the contract's own
 * conformance harness when this portal joined the contract. The harness knows
 * which role owes 4.5:1 and which owes 3:1, and it checks every ink against
 * every ground rather than the subset somebody thought to list — which is how
 * it found three defects the old table could not:
 *
 * - the primary button's label, `text-bg` on a gold fill, at **2.42:1** in light;
 * - the same button's hover, `bg-gold-dim` composited over the page, at
 *   **1.80:1** in dark;
 * - `success` and `warn` on `bg-deep` and `surface-sunk`, at 4.20–4.39:1.
 *
 * `--on-gold` and `--gold-hi` are the tokens that fixed the first two.
 *
 * What stays here is what the contract has no name for. cire carries two accent
 * families, `--ui-accent` is the gold one, and the brand green survives for
 * this product's own use — so this file still owns the green's pairs, and the
 * ramp's *shape* (which is not a contrast question at all).
 */

const CSS = readFileSync(
  fileURLToPath(new URL("../../src/styles/global.css", import.meta.url)),
  "utf8",
);

/**
 * Light and dark, as the harness sees them.
 *
 * Dark is the default and lives on bare `:root`, so light is `:root` THEN the
 * explicit override — the attribute block supplies only what it changes, and
 * the rest still comes from `:root`.
 */
const SCOPES = [
  { name: "dark", selectors: [":root"] },
  { name: "light", selectors: [":root", ':root[data-theme="light"]'] },
] as const;

describe("design-token contract", () => {
  it("maps every role without breaking contrast, in both themes", () => {
    // `check` rather than `assert` so a failure arrives as a diff of readable
    // lines against `[]`, listing every bad pair at once rather than stopping
    // at the first.
    const failures = checkContractConformance({ css: CSS, scopes: SCOPES });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`)).toEqual([]);
  });

  it("imports the contract stylesheet, or none of the above is loaded at all", () => {
    // Without the import the mapping is a block of custom properties no utility
    // reads, and this file would assert happily about a contract the app does
    // not actually use.
    expect(CSS).toMatch(/@import\s+["']@shared\/design-tokens\/tokens\.css["']/);
  });

  it("sends the accent to gold, not to the brand green", () => {
    // The decision the mapping turns on, and the one a reader coming from the
    // shadcn block it replaced would get backwards — `--color-primary` used to
    // be `--brand`. Counted across both portals' components, gold appears in 422
    // colour utilities and the green in 8.
    expect(CSS).toMatch(/--ui-accent:\s*var\(--gold\)/);
    expect(CSS).not.toMatch(/--ui-accent:\s*var\(--brand\)/);
  });

  it("maps the contract through aliases, so `data-theme` carries it", () => {
    // A literal would pin the dark value into light, and the failure would
    // surface much later as "light mode ignores the theme".
    const mapping = CSS.slice(CSS.indexOf("--ui-ground:"), CSS.indexOf("--ui-radius-hair:"));
    expect([...mapping.matchAll(/(--ui-[\w-]+):\s*(oklch|#)/gi)].map((m) => m[1])).toEqual([]);
  });

  it("maps all seven type steps rather than leaving gaps for the fallback", () => {
    // A shared component using a step this app has not mapped renders the
    // package's neutral default — a different type system showing through in
    // the middle of this one.
    for (const step of ["xs", "sm", "base", "md", "lg", "xl", "2xl"]) {
      expect(CSS).toMatch(new RegExp(`--ui-text-${step}:`));
    }
  });
});

/** This package's own stylesheet, at one theme's selector. */
function ramp(selector: string): Map<string, Oklch> {
  return cssRamp(CSS, selector);
}

// The dark ramp is the only `:root` block carrying `color-scheme: dark` — the
// other bare `:root` blocks hold motion, toast and the contract mapping.
const DARK = ramp(":root {\n  color-scheme: dark;");
const LIGHT = ramp(':root[data-theme="light"]');
const LIGHT_SYSTEM = ramp(":root:not([data-theme])");

/**
 * The brand green, which the contract does not name.
 *
 * `--ui-accent` is gold, so nothing in the harness above measures this family.
 * It is still in the ramp and still in use, so its pairs are asserted here.
 * Every one is opaque, which is why there is no compositing step: the harness
 * owns that now, and the translucent tokens are all on its side of the line.
 */
function ratio(tokens: Map<string, Oklch>, fg: string, bg: string): number {
  const f = tokens.get(fg);
  const b = tokens.get(bg);
  if (!f) throw new Error(`missing token --${fg}`);
  if (!b) throw new Error(`missing token --${bg}`);
  if (f.a < 1) throw new Error(`--${fg} is translucent; measure it through the contract harness`);
  return contrastOklch(f, b);
}

describe.each([
  ["dark", DARK],
  ["light", LIGHT],
] as const)("%s ramp — the brand green", (_name, tokens) => {
  it.each([
    ["brand-ink", "bg"],
    ["brand-ink", "surface"],
    ["on-brand", "brand"],
  ] as const)("--%s on --%s clears 4.5:1", (fg, bg) => {
    expect(ratio(tokens, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("--on-brand on the hover fill --brand-hi clears 3:1", () => {
    // The gold equivalent of this pair was 1.80:1 before the contract found it.
    expect(ratio(tokens, "on-brand", "brand-hi")).toBeGreaterThanOrEqual(3);
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
