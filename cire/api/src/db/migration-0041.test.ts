import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Index-only migration: partial UNIQUE on vendors(wedding_id, directory_vendor_id)
// WHERE directory_vendor_id IS NOT NULL, and a plain index on
// directory_vendors(listed). No structural rebuild — apply the full chain and
// assert the index semantics directly.
//
// Mirrors the seeding idiom of migration-0033.test.ts (bun:sqlite Database,
// apply full chain via readFileSync + db.exec, insert via raw SQL).

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();

function applyAllMigrations(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

describe("0041 directory browse indexes", () => {
  it("rejects a second CRM row for the same (wedding, directory listing)", () => {
    const db = applyAllMigrations();

    // Seed a wedding (required FK for vendors.wedding_id).
    db.exec(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES ('wed_x', 'wx', 'WX', 'usr_o', 0, 0);",
    );

    // Seed a directory_vendors listing (vendors.directory_vendor_id is not a FK,
    // but inserting an actual listing keeps the data honest).
    db.exec(
      "INSERT INTO directory_vendors (id, name, listed, created_at, updated_at)" +
        " VALUES ('dv_1', 'Florist Co', 'listed', 0, 0);",
    );

    // First vendor linked to this listing → ok.
    db.exec(
      "INSERT INTO vendors (id, wedding_id, directory_vendor_id, name, category, created_at, updated_at)" +
        " VALUES ('v_1', 'wed_x', 'dv_1', 'Florist Co', 'florist', 0, 0);",
    );

    // Second vendor with the SAME (wedding_id, directory_vendor_id) → must throw UNIQUE.
    expect(() =>
      db.exec(
        "INSERT INTO vendors (id, wedding_id, directory_vendor_id, name, category, created_at, updated_at)" +
          " VALUES ('v_2', 'wed_x', 'dv_1', 'Florist Co Dup', 'florist', 0, 0);",
      ),
    ).toThrow(/UNIQUE/i);

    db.close();
  });

  it("permits multiple manual rows (directory_vendor_id NULL) in one wedding", () => {
    const db = applyAllMigrations();

    // Seed a wedding.
    db.exec(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES ('wed_y', 'wy', 'WY', 'usr_o', 0, 0);",
    );

    // Two manual (directory_vendor_id = NULL) rows in the same wedding — the
    // partial index excludes NULLs, so both must succeed.
    db.exec(
      "INSERT INTO vendors (id, wedding_id, directory_vendor_id, name, category, created_at, updated_at)" +
        " VALUES ('v_3', 'wed_y', NULL, 'My Florist', 'florist', 0, 0);",
    );
    db.exec(
      "INSERT INTO vendors (id, wedding_id, directory_vendor_id, name, category, created_at, updated_at)" +
        " VALUES ('v_4', 'wed_y', NULL, 'My Photographer', 'photographer', 0, 0);",
    );

    const count = (
      db.query("SELECT COUNT(*) AS n FROM vendors WHERE wedding_id = 'wed_y'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(2);

    db.close();
  });
});
