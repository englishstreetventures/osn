import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { databaseBefore } from "../test-helpers/archived-chain";

// Data proof for migration 0077, which adds the soft-delete pair to `weddings`.
// Structural lockstep is ddl-lockstep.test.ts's job; what this replays is what
// a structural diff cannot see — that every wedding already in the database
// reads as live afterwards, and that the purge's index holds deleted rows only.
//
// Reads cire/db/migrations-archive/: the live baseline already contains this
// migration, and replaying history is the point here.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations-archive");

const MIG_0077 = "0077_wedding_soft_delete.sql";

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function migratedWithOneWedding(): Database {
  const db = databaseBefore(MIG_0077, { foreignKeys: true });
  db.exec(
    "INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_a', 'a-1', 'A', 1, 1)",
  );
  apply(db, MIG_0077);
  return db;
}

describe("migration 0077 — wedding soft delete", () => {
  it("leaves every wedding that already exists live", () => {
    const db = migratedWithOneWedding();
    const row = db
      .query("SELECT deleted_at, deleted_by_osn_profile_id FROM weddings WHERE id = 'wed_a'")
      .get() as { deleted_at: number | null; deleted_by_osn_profile_id: string | null };
    expect(row).toEqual({ deleted_at: null, deleted_by_osn_profile_id: null });
  });

  it("adds a partial index on deleted_at that the purge's read uses", () => {
    const db = migratedWithOneWedding();
    const index = db
      .query(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'weddings_deleted_at_idx'",
      )
      .get() as { sql: string } | null;
    expect(index?.sql).toContain("WHERE deleted_at IS NOT NULL");
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT id FROM weddings WHERE deleted_at IS NOT NULL AND deleted_at <= 100 ORDER BY deleted_at",
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("weddings_deleted_at_idx");
  });
});
