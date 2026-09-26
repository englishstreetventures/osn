import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { faqs } from "../../seed/data";

// seed.test.ts proves dev-seed.sql is what the generator emits; this proves
// that SQL runs. It builds a database from the migration chain, as the dev
// deploy does (reset → migrate → seed), applies the seed on top, and reads a
// block back, so a column list that no longer matches the schema fails here
// rather than on the dev deploy.
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const SEED = new URL("../../seed/dev-seed.sql", import.meta.url);

function seededDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  db.exec(readFileSync(SEED, "utf8"));
  return db;
}

describe("dev-seed.sql against the migrated schema", () => {
  it("applies without error", () => {
    expect(() => seededDatabase()).not.toThrow();
  });

  it("seeds the invite FAQ in order, dated in epoch seconds", () => {
    const rows = seededDatabase()
      .query<{ id: string; question: string; sort_order: number; created_at: number }, []>(
        "SELECT id, question, sort_order, created_at FROM wedding_faqs ORDER BY sort_order, id",
      )
      .all();
    expect(rows.map((r) => [r.id, r.question, r.sort_order])).toEqual(
      faqs.map((f) => [f.id, f.question, f.sortOrder]),
    );
    for (const row of rows) {
      expect(Math.abs(row.created_at - Date.now() / 1000)).toBeLessThan(60);
    }
  });
});
