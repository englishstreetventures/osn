/**
 * Guard: `makeSafeError` forwards the `message` of allow-listed tagged
 * errors (`GraphError`, `OrgError`, `NotFoundError`) verbatim to clients, so
 * every construction site must use a static string literal — an interpolated
 * cause or user input would silently re-open the DB-internals leak the
 * allowlist exists to prevent. This test reads every source file and fails on
 * any construction whose argument is not exactly `{ message: "<literal>" }`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../../src");

/** Every `new GraphError(` (and friends); the argument is read after it. */
const CONSTRUCTION = /new (?:GraphError|OrgError|NotFoundError)\(/g;

/** The one argument shape allowed: an object holding only a literal message. */
const LITERAL_ARGUMENT = /^\{\s*message:\s*(?:"[^"$`\\]*"|'[^'$`\\]*')\s*,?\s*\}\s*\)/;

const read = (file: string) => readFileSync(join(SRC, file), "utf8");

const constructing = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => read(file).match(CONSTRUCTION) !== null)
  .toSorted();

describe("allow-listed error messages are static literals", () => {
  it("finds constructions to check in the source tree", () => {
    // Sanity: the pattern actually finds constructions (guards against the
    // regex silently rotting if the construction style changes).
    expect(constructing.length).toBeGreaterThan(0);
  });

  for (const file of constructing) {
    it(`${file} constructs client-visible errors from string literals only`, () => {
      const source = read(file);
      const violations: string[] = [];
      for (const match of source.matchAll(CONSTRUCTION)) {
        const rest = source.slice(match.index + match[0].length);
        if (!LITERAL_ARGUMENT.test(rest)) violations.push(`${match[0]}${rest.slice(0, 60)}`);
      }
      expect(violations, `non-literal error messages in ${file}`).toEqual([]);
    });
  }
});
