import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { generateResetSql, generateSeedSql, schemaTableNames } from "../../seed/generate";

// dev-seed.sql is DERIVED from cire/db/seed/data/ by generate.ts — it must never
// be hand-edited. This test regenerates the SQL in memory and compares it to the
// committed file, so any drift (someone editing the .sql directly, or the data
// without rerunning the generator) fails CI. Fix: `bun run --cwd cire/db seed:generate`.
describe("dev-seed.sql", () => {
  it("is in sync with the canonical seed data", () => {
    const committed = readFileSync(new URL("../../seed/dev-seed.sql", import.meta.url), "utf8");
    expect(committed).toBe(generateSeedSql());
  });
});

// dev-reset.sql is DERIVED from cire/db/src/schema.ts. A table added to the
// schema without regenerating leaves that table standing after a "reset", and
// the dev deploy's migration replay then fails on CREATE TABLE. Catch it here
// instead. Fix: `bun run --cwd cire/db seed:generate`.
describe("dev-reset.sql", () => {
  it("is in sync with the schema's table list", () => {
    const committed = readFileSync(new URL("../../seed/dev-reset.sql", import.meta.url), "utf8");
    expect(committed).toBe(generateResetSql());
  });

  it("drops every schema table plus the migration ledger", () => {
    const committed = readFileSync(new URL("../../seed/dev-reset.sql", import.meta.url), "utf8");
    for (const table of [...schemaTableNames(), "d1_migrations"]) {
      expect(committed).toContain(`DROP TABLE IF EXISTS ${table};`);
    }
  });
});
