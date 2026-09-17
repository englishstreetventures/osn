import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkContractConformance } from "@shared/design-tokens/conformance";
import { describe, expect, it } from "vitest";

/**
 * Does the marketing site's mapping onto `@shared/design-tokens` clear the
 * contrast floors the contract promises?
 *
 * The same claim `cire/invites` makes, and worth making twice: this site's
 * brand block is meant to be the guest site's, so the two mappings should agree
 * — and the check below for whether they actually do is the reason this file
 * found a defect rather than confirming one.
 */

const CSS = readFileSync(join(import.meta.dirname, "../../src/styles/global.css"), "utf8");

const INVITES_CSS = readFileSync(
  join(import.meta.dirname, "../../../invites/src/styles/global.css"),
  "utf8",
);

/** One scope: this site has one theme. `@theme` holds the brand literals, `:root` the mapping. */
const SCOPES = [{ name: "brand", selectors: ["@theme", ":root"] }] as const;

/** Every `--color-*` a `@theme` block declares, by name. */
function brandTokens(css: string): Map<string, string> {
  const at = css.indexOf("@theme");
  const end = css.indexOf("\n}", at);
  return new Map(
    [...css.slice(at, end).matchAll(/(--color-[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  );
}

describe("design-token contract", () => {
  it("maps every role without breaking contrast", () => {
    const failures = checkContractConformance({ css: CSS, scopes: SCOPES });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`)).toEqual([]);
  });

  it("imports the contract stylesheet, or none of the above is loaded at all", () => {
    expect(CSS).toMatch(/@import\s+["']@shared\/design-tokens\/tokens\.css["']/);
  });

  it("maps the contract through aliases rather than literals", () => {
    const mapping = CSS.slice(CSS.indexOf("--ui-ground:"), CSS.indexOf("--ui-radius-hair:"));
    expect([...mapping.matchAll(/(--ui-[\w-]+):\s*(oklch|#)/gi)].map((m) => m[1])).toEqual([]);
  });

  it("maps all seven type steps rather than leaving gaps for the fallback", () => {
    for (const step of ["xs", "sm", "base", "md", "lg", "xl", "2xl"]) {
      expect(CSS).toMatch(new RegExp(`--ui-text-${step}:`));
    }
  });
});

describe("brand parity with the guest site", () => {
  /**
   * Every shared colour token matches the guest site's value. A name goes in
   * this set only with a reason in the same breath — a deliberate divergence,
   * asserted by a test, not an untracked drift.
   */
  const KNOWN_DIVERGENCES = new Set<string>([]);

  it("keeps every shared brand token equal to the guest site's", () => {
    const mine = brandTokens(CSS);
    const theirs = brandTokens(INVITES_CSS);
    const drifted = [...mine]
      .filter(([name, value]) => theirs.has(name) && theirs.get(name) !== value)
      .filter(([name]) => !KNOWN_DIVERGENCES.has(name))
      .map(([name, value]) => `${name}: ${value} vs ${theirs.get(name)}`);
    expect(drifted).toEqual([]);
  });

  it("does not list a divergence that no longer exists", () => {
    // A stale entry here is worse than none: it silently exempts a token that
    // has since been brought back into line, so the next drift in it passes.
    const mine = brandTokens(CSS);
    const theirs = brandTokens(INVITES_CSS);
    const stale = [...KNOWN_DIVERGENCES].filter((name) => mine.get(name) === theirs.get(name));
    expect(stale).toEqual([]);
  });
});
