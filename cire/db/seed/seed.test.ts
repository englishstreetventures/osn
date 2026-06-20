import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { generateSeedSql } from "./generate";

// dev-seed.sql is DERIVED from cire/db/seed/data/ by generate.ts — it must never
// be hand-edited. This test regenerates the SQL in memory and compares it to the
// committed file, so any drift (someone editing the .sql directly, or the data
// without rerunning the generator) fails CI. Fix: `bun run --cwd cire/db seed:generate`.
describe("dev-seed.sql", () => {
  it("is in sync with the canonical seed data", () => {
    const committed = readFileSync(new URL("./dev-seed.sql", import.meta.url), "utf8");
    expect(committed).toBe(generateSeedSql());
  });
});
