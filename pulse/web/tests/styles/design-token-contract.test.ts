/**
 * Does pulse's mapping onto `@shared/design-tokens` clear the contrast floors
 * the contract promises?
 *
 * The app's half of the contract: `@shared/design-tokens` says what the roles
 * owe, this asserts pulse's colours pay it. A shared component rendered here
 * reads the contract, so a mapping that puts secondary ink under 4.5:1 makes
 * every `@shared/ui` primitive illegible in this app and in no other.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkContractConformance } from "@shared/design-tokens/conformance";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("../../src/app.css", import.meta.url)), "utf8");

const SCOPES = [
  { name: "light", selectors: [":root"] },
  { name: "dark", selectors: [":root", ".dark"] },
] as const;

/**
 * One token pulse maps but cannot currently defend.
 *
 * A waiver suppresses the assertion and changes nothing that renders: `--input`
 * is still mapped, so shared components draw pulse's own border rather than
 * falling back to the package's neutral grey.
 */
const WAIVED = {
  "--ui-hairline-strong": [
    "`--input` measures 1.13-1.27:1 in light and 1.10-1.31:1 in dark against",
    "pulse's own grounds, versus a 3:1 floor. Same class of defect as",
    "@musubi/social's and the same decision: darken the border and lose the",
    "hairline, or give controls a perceivable fill and keep it. Tracked as",
    "osn-tracker#653.",
  ].join(" "),
} as const;

describe("design-token contract", () => {
  it("maps every role without breaking contrast, in both themes", () => {
    const failures = checkContractConformance({ css: CSS, scopes: SCOPES, waived: WAIVED });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`)).toEqual([]);
  });

  it("sends the coral to nothing — `--ui-accent` is the neutral `--primary`", () => {
    // Pulse has two accents. The contract has one, and it means "the ground of
    // a primary button", which here is the near-black. Mapping the coral would
    // repaint every shared <Button> in the app — a redesign disguised as a
    // refactor, and exactly the kind of thing "renders identically" is meant to
    // rule out.
    expect(CSS).toMatch(/--ui-accent:\s*var\(--primary\)/);
    expect(CSS).not.toMatch(/--ui-accent:\s*var\(--pulse-accent\)/);
    expect(CSS).not.toMatch(/--ui-accent-soft:\s*var\(--pulse-accent-soft\)/);
  });

  it("imports the contract stylesheet, or the mapping is dead custom properties", () => {
    expect(CSS).toMatch(/@import\s+["']@shared\/design-tokens\/tokens\.css["']/);
  });

  it("maps all seven type steps rather than leaving gaps for the fallback", () => {
    // Pulse had none of these until the scale was written down, so every
    // `text-ui-*` in a shared component resolved to the contract package's
    // neutral default — a different type system showing through in the middle
    // of this one, and invisible, because a fallback renders legibly.
    for (const step of ["xs", "sm", "base", "md", "lg", "xl", "2xl"]) {
      expect(CSS).toMatch(new RegExp(`--ui-text-${step}:`));
    }
  });

  it("keeps the scale ascending, which is the one thing a list of sizes can get wrong", () => {
    // Seven hand-written px values in source order. A transposed pair is not
    // visible reading the block and produces a component whose "large" step is
    // smaller than its "medium" one.
    const sizes = ["xs", "sm", "base", "md", "lg", "xl", "2xl"].map((step) => {
      const match = CSS.match(new RegExp(`--ui-text-${step}:\\s*([\\d.]+)px`));
      if (!match) throw new Error(`--ui-text-${step} is not a px value`);
      return Number.parseFloat(match[1]!);
    });
    expect(sizes).toEqual(sizes.toSorted((a, b) => a - b));
  });
});
