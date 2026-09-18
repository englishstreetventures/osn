import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every `text-*`, `tracking-*` and `leading-*` on this site reads a named step —
 * one of the app's own `@theme` entries, or a built-in one — rather than a
 * literal value in square brackets.
 *
 * This is a test rather than a lint rule because it cannot be a lint rule:
 * `shadcn/no-arbitrary-values` is at `error` and would report every one of
 * these, but `oxlintrc.json` lists `*.astro` under `ignorePatterns`, so oxlint
 * never parses the seven files where this site's type actually lives. 53 literal
 * values accumulated there behind a rule that was reporting zero.
 *
 * A value built from `var()`, `clamp()`, `calc()`, `env()` or `min()` is
 * excluded, the same way the rule excludes it: those read a length decided at
 * runtime rather than hardcoding a step. `text-[var(--color-text)]` is also how
 * a colour is spelled, so the exclusion is doing double duty.
 */
const SRC = join(import.meta.dirname, "..", "src");

/** `text-[…]` / `tracking-[…]` / `leading-[…]`, unless the brackets hold a function call. */
const LITERAL_TYPE_VALUE =
  /(?:text|tracking|leading)-\[(?![^\]]*(?:var|clamp|calc|env|min)\()[^\]]+\]/g;

/** Every `.astro` and `.tsx` file under `src/`. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, acc);
    else if (entry.name.endsWith(".astro") || entry.name.endsWith(".tsx")) acc.push(path);
  }
  return acc;
}

describe("the named type scale", () => {
  it("is what every type utility on the site reads", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const matches = readFileSync(file, "utf8").match(LITERAL_TYPE_VALUE) ?? [];
      return matches.map((value) => `${file.slice(SRC.length + 1)}: ${value}`);
    });

    expect(offenders).toEqual([]);
  });

  it("declares every step the sections name", () => {
    const css = readFileSync(join(SRC, "styles", "global.css"), "utf8");

    // A `@theme` entry that is missing, or misspelled, emits no rule at all —
    // no error and no warning — and the class simply does nothing. Listing them
    // here is what turns that into a failure.
    for (const token of [
      "--text-tag",
      "--text-meta",
      "--text-eyebrow",
      "--text-copy",
      "--text-lede",
      "--text-subhead",
      "--text-glyph-sm",
      "--text-glyph-lg",
      "--tracking-mono-wide",
      "--tracking-mono-wider",
      "--tracking-mono-widest",
      "--leading-display",
      "--leading-heading",
      "--leading-copy",
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });
});
