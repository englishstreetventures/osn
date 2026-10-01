import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TIERS } from "../../src/lib/tiers";

/**
 * The portal's tier list against the two it mirrors.
 *
 * `@cire/host` depends on neither `@cire/api` nor `@cire/db`, so `TIERS` in
 * `src/lib/tiers.ts` is a hand-kept copy of the API's ranking. The order is the
 * ranking on both sides, so a tier added or moved in the API alone would have
 * the portal unlock a module the API answers 402 for, or lock one the wedding
 * paid for. These read the source files and fail when either drifts — a text
 * pin, like `tests/lib/wedding-roles.contract.test.ts`.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** The quoted strings inside the first match of `pattern` in `source`, in order. */
function listIn(source: string, pattern: RegExp, file: string): string[] {
  const declaration = source.match(pattern)?.[1];
  // A null here means the declaration was rewritten into a shape this regex no
  // longer sees, which is exactly the drift this file exists to catch.
  expect(declaration, `could not read the tier list from ${file}`).toBeTruthy();
  return [...(declaration ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the portal's tiers match the API's and the column's", () => {
  it("ranks the same tiers in the same order as cire/api/src/services/tiers.ts", () => {
    const file = "cire/api/src/services/tiers.ts";
    const api = read("../../../api/src/services/tiers.ts");
    expect([...TIERS]).toEqual(listIn(api, /export const TIERS = \[([^\]]+)\] as const;/, file));
  });

  it("names every value weddings.tier can hold", () => {
    const file = "cire/db/src/schema.ts";
    const schema = read("../../../db/src/schema.ts");
    expect([...TIERS]).toEqual(
      listIn(schema, /tier: text\("tier", \{ enum: \[([^\]]+)\] \}\)/, file),
    );
  });
});
