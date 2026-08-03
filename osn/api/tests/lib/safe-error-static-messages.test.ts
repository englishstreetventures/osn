/**
 * S-M17 guard: `makeSafeError` forwards the `message` of allow-listed tagged
 * errors (`GraphError`, `OrgError`, `NotFoundError`) verbatim to clients, so
 * every construction site must use a static string literal — an interpolated
 * cause or user input would silently re-open the DB-internals leak the
 * allowlist exists to prevent. This test greps the service sources and fails
 * on any non-literal message.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SERVICE_FILES = ["graph.ts", "organisation.ts"];

/** Matches `new GraphError({ message:` (and friends) plus what follows. */
const CONSTRUCTION = /new (?:GraphError|OrgError|NotFoundError)\(\s*\{\s*message:\s*([^,}]*)/g;

describe("allow-listed error messages are static literals", () => {
  for (const file of SERVICE_FILES) {
    it(`${file} constructs client-visible errors from string literals only`, () => {
      const source = readFileSync(join(__dirname, "../../src/services", file), "utf8");
      const violations: string[] = [];
      for (const match of source.matchAll(CONSTRUCTION)) {
        const value = match[1].trim();
        // A plain quoted string with no template interpolation.
        const isLiteral = /^"[^"]*"$/.test(value) || /^'[^']*'$/.test(value);
        if (!isLiteral) violations.push(match[0]);
      }
      expect(violations, `non-literal error messages in ${file}`).toEqual([]);
      // Sanity: the pattern actually finds constructions (guards against the
      // regex silently rotting if the construction style changes).
      expect([...source.matchAll(CONSTRUCTION)].length).toBeGreaterThan(0);
    });
  }
});
