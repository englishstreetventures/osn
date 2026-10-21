import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

// Data proof for migration 0088, which adds `registry_contributions.item_title`
// and copies the current title of the listing each gift names onto it. A gift
// to no listing, and one whose listing is already gone, stay NULL, and nothing
// else about any gift changes.
//
// 0088 is a live migration, so the chain before it is the live directory: the
// baseline and everything after it, in name order, as wrangler runs them.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG_0088 = "0088_contribution_item_title.sql";

function apply(db: Database, file: string): void {
  for (const statement of migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))) {
    db.exec(statement);
  }
}

function databaseBefore0088(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const chain = listMigrations(MIGRATIONS_DIR);
  for (const file of chain.slice(0, chain.indexOf(MIG_0088))) {
    apply(db, file);
  }
  return db;
}

function seeded(): Database {
  const db = databaseBefore0088();
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES
      ('wed_a', 'a', 'A', 1, 1), ('wed_b', 'b', 'B', 1, 1);
    INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES
      ('fam_a', 'wed_a', 'GUEST-A', 'Guest', 1, 1),
      ('fam_b', 'wed_b', 'GUEST-B', 'Guest', 1, 1);
    INSERT INTO registry_items (id, wedding_id, kind, title, created_at, updated_at) VALUES
      ('it_fund', 'wed_a', 'cash_fund', 'Honeymoon', 1, 1),
      ('it_pan', 'wed_a', 'product', 'Copper pan', 1, 1),
      ('it_gone', 'wed_a', 'cash_fund', 'Deleted before 0088', 1, 1),
      ('it_b', 'wed_b', 'cash_fund', 'House deposit', 1, 1);
    INSERT INTO registry_contributions
      (id, wedding_id, item_id, family_id, status, amount_minor, currency, message, created_at, updated_at)
    VALUES
      ('rct_fund', 'wed_a', 'it_fund', 'fam_a', 'succeeded', 5000, 'AUD', 'a note', 1, 1),
      ('rct_pan', 'wed_a', 'it_pan', 'fam_a', 'refunded', 4000, 'AUD', NULL, 1, 1),
      ('rct_general', 'wed_a', NULL, 'fam_a', 'succeeded', 3000, 'AUD', NULL, 1, 1),
      ('rct_gone', 'wed_a', 'it_gone', 'fam_a', 'pending', 2000, 'AUD', NULL, 1, 1),
      ('rct_b', 'wed_b', 'it_b', 'fam_b', 'succeeded', 1000, 'AUD', NULL, 1, 1);
    DELETE FROM registry_items WHERE id = 'it_gone';
  `);
  return db;
}

type Row = {
  id: string;
  item_id: string | null;
  status: string;
  amount_minor: number;
  message: string | null;
  updated_at: number;
  item_title?: string | null;
};

const COLUMNS = "id, item_id, status, amount_minor, message, updated_at";

/** Every gift by id; `item_title` only once the migration has added it. */
function gifts(db: Database, withTitle = true): Map<string, Row> {
  const rows = db
    .query(`SELECT ${COLUMNS}${withTitle ? ", item_title" : ""} FROM registry_contributions`)
    .all() as Row[];
  return new Map(rows.map((row) => [row.id, row]));
}

describe("migration 0088 — a money gift keeps the name of what it was given to", () => {
  it("copies each listing's title onto the gifts that name it, on every wedding", () => {
    const db = seeded();
    apply(db, MIG_0088);
    const after = gifts(db);
    expect(after.get("rct_fund")?.item_title).toBe("Honeymoon");
    expect(after.get("rct_pan")?.item_title).toBe("Copper pan");
    expect(after.get("rct_b")?.item_title).toBe("House deposit");
  });

  it("leaves a gift to no listing, and one whose listing is gone, without a name", () => {
    const db = seeded();
    apply(db, MIG_0088);
    const after = gifts(db);
    expect(after.get("rct_general")?.item_title).toBeNull();
    // SET NULL already cleared the id when the listing went; its name is lost.
    expect(after.get("rct_gone")?.item_id).toBeNull();
    expect(after.get("rct_gone")?.item_title).toBeNull();
  });

  it("changes nothing else about any gift, and deletes none", () => {
    const db = seeded();
    const before = gifts(db, false);
    apply(db, MIG_0088);
    const after = gifts(db, false);
    expect(after).toEqual(before);
  });
});
