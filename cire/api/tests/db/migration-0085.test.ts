import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data proof for migration 0085, which sets every live gift claim a wedding's
// host preview household holds to `released`: a preview holds no claim. A
// guest's claim, and every column but the status and its timestamp, stay as
// they were.
//
// 0085 is a live migration, so the chain before it is the live directory:
// the baseline and everything after it, in name order, as wrangler runs them.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG_0085 = "0085_release_preview_claims.sql";

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function databaseBefore0085(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < MIG_0085)
    .toSorted()) {
    apply(db, file);
  }
  return db;
}

/** `[id, family, item, status]`, all written at epoch second 1 with a note. */
const CLAIMS = [
  ["rcl_guest", "fam_guest", "it_a1", "reserved"],
  ["rcl_host_reserved", "fam_host_a", "it_a1", "reserved"],
  ["rcl_host_purchased", "fam_host_a", "it_a2", "purchased"],
  ["rcl_host_released", "fam_host_a", "it_a3", "released"],
  ["rcl_host_other", "fam_host_b", "it_b1", "reserved"],
] as const;

function seeded(): Database {
  const db = databaseBefore0085();
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES
      ('wed_a', 'a', 'A', 1, 1), ('wed_b', 'b', 'B', 1, 1);
    INSERT INTO families (id, wedding_id, public_id, family_name, kind, created_at, updated_at) VALUES
      ('fam_guest', 'wed_a', 'GUEST-A', 'Guest', 'guest', 1, 1),
      ('fam_host_a', 'wed_a', 'HOST-A', 'Host', 'host', 1, 1),
      ('fam_host_b', 'wed_b', 'HOST-B', 'Host', 'host', 1, 1);
    INSERT INTO registry_items (id, wedding_id, title, created_at, updated_at) VALUES
      ('it_a1', 'wed_a', 'Pan', 1, 1), ('it_a2', 'wed_a', 'Bowl', 1, 1),
      ('it_a3', 'wed_a', 'Jug', 1, 1), ('it_b1', 'wed_b', 'Pan', 1, 1);
  `);
  const insert = db.prepare(
    "INSERT INTO registry_claims (id, family_id, item_id, status, wedding_id, quantity, note, created_at, updated_at) VALUES (?, ?, ?, ?, (SELECT wedding_id FROM registry_items WHERE id = ?), 1, 'a note', 1, 1)",
  );
  for (const [id, family, item, status] of CLAIMS) insert.run(id, family, item, status, item);
  return db;
}

type Row = { id: string; status: string; quantity: number; note: string; updated_at: number };

function claims(db: Database): Map<string, Row> {
  const rows = db
    .query("SELECT id, status, quantity, note, updated_at FROM registry_claims")
    .all() as Row[];
  return new Map(rows.map((row) => [row.id, row]));
}

describe("migration 0085 — preview households hold no gifts", () => {
  it("releases every live claim a host preview household holds, on every wedding", () => {
    const db = seeded();
    const before = Math.floor(Date.now() / 1000);
    apply(db, MIG_0085);
    const after = claims(db);
    for (const id of ["rcl_host_reserved", "rcl_host_purchased", "rcl_host_other"]) {
      const row = after.get(id);
      expect(row?.status).toBe("released");
      // Epoch seconds, as drizzle's timestamp columns hold, and fresh.
      expect(row?.updated_at).toBeGreaterThanOrEqual(before);
      expect(row?.updated_at).toBeLessThan(before + 60);
      expect(row?.quantity).toBe(1);
      expect(row?.note).toBe("a note");
    }
  });

  it("leaves a guest's claim, and a claim already released, as they were", () => {
    const db = seeded();
    apply(db, MIG_0085);
    const after = claims(db);
    expect(after.get("rcl_guest")).toEqual({
      id: "rcl_guest",
      status: "reserved",
      quantity: 1,
      note: "a note",
      updated_at: 1,
    });
    expect(after.get("rcl_host_released")?.updated_at).toBe(1);
  });
});
