import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

// Proof for migration 20261106023546_contribution_currency_check, which
// rebuilds `registry_contributions` to add two CHECKs: `currency` is three
// characters long, and `primary_currency` is NULL or three characters long.
// The rebuild copies every gift; nothing about any gift may change, and a
// stored gift that breaks a check stops the migration rather than being left
// behind. The D1 replay of the same file is in d1-integration.test.ts.
//
// It is a live migration, so the chain before it is the live directory: the
// baseline and everything after it, in the order wrangler runs them.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG_CURRENCY_CHECK = "20261106023546_contribution_currency_check.sql";

/** A file as wrangler sends it, one statement at a time, so a statement
 *  SQLite refuses throws here. */
function apply(db: Database, file: string): void {
  for (const statement of migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))) {
    db.exec(statement);
  }
}

function databaseBeforeCurrencyCheck(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const chain = listMigrations(MIGRATIONS_DIR);
  const cut = chain.indexOf(MIG_CURRENCY_CHECK);
  expect(cut).toBeGreaterThan(0);
  for (const file of chain.slice(0, cut)) apply(db, file);
  return db;
}

/**
 * One wedding with a cash fund and two gifts. `rct_full` sets every column,
 * each to a value no other column holds, so a column left out of the copy or
 * swapped with another of its type shows; `rct_sparse` leaves every nullable
 * column NULL. Neither has the default status, so a copy that drops `status`
 * shows too. `rct_full`'s codes are in lower case, which both checks allow.
 */
function seeded(): Database {
  const db = databaseBeforeCurrencyCheck();
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_a', 'a', 'A', 1, 1);
    INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES
      ('fam_a', 'wed_a', 'GUEST-A', 'Guest', 1, 1);
    INSERT INTO registry_items (id, wedding_id, kind, title, created_at, updated_at) VALUES
      ('it_fund', 'wed_a', 'cash_fund', 'Honeymoon', 1, 1);
    INSERT INTO registry_contributions (
      id, wedding_id, item_id, item_title, family_id, status, amount_minor, currency,
      primary_amount_minor, primary_currency, fx_rate, fx_rate_at, refunded_amount_minor,
      stripe_checkout_session_id, stripe_payment_intent_id, message, display_name,
      thanked_at, thanked_by, note_hidden_at, note_hidden_by_osn_profile_id, created_at, updated_at
    ) VALUES (
      'rct_full', 'wed_a', 'it_fund', 'Honeymoon fund', 'fam_a', 'refunded', 5000, 'aud',
      3300, 'usd', '0.66', 1700000101, 1200,
      'cs_full', 'pi_full', 'for the trip', 'Auntie Ros',
      1700000102, 'usr_thanker', 1700000103, 'usr_hider', 1700000104, 1700000105
    );
    INSERT INTO registry_contributions
      (id, wedding_id, family_id, status, amount_minor, currency, created_at, updated_at)
    VALUES
      ('rct_sparse', 'wed_a', 'fam_a', 'succeeded', 2500, 'NZD', 1700000201, 1700000202);
  `);
  return db;
}

const gifts = (db: Database): Array<Record<string, unknown>> =>
  db.query("SELECT * FROM registry_contributions ORDER BY id").all() as Array<
    Record<string, unknown>
  >;

/** Insert one gift on the seeded wedding; throws when SQLite refuses it. */
function give(db: Database, id: string, currency: string, primaryCurrency: string | null): void {
  db.query(
    "INSERT INTO registry_contributions (id, wedding_id, family_id, amount_minor, currency, primary_currency, created_at, updated_at) VALUES (?, 'wed_a', 'fam_a', 100, ?, ?, 1, 1)",
  ).run(id, currency, primaryCurrency);
}

describe("migration 20261106023546 — a gift's currency is three characters", () => {
  it("rebuilds a table no foreign key, trigger or view names", () => {
    // The rebuild's DROP TABLE cascades into any table whose foreign key points
    // here, and drops any trigger on it; the chain before it holds neither.
    const db = databaseBeforeCurrencyCheck();
    expect(
      db
        .query(
          "SELECT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f.\"table\" = 'registry_contributions'",
        )
        .all(),
    ).toEqual([]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view') AND sql LIKE '%registry_contributions%'",
        )
        .all(),
    ).toEqual([]);
    db.close();
  });

  it("keeps every index under its name and every foreign key, and changes no other table", () => {
    // A later migration names an index to drop or replace it, and the lockstep
    // test compares indexes by their columns alone, so a rebuild that renamed
    // one would pass there. The other tables' triggers are re-checked by
    // SQLite when the copy is renamed; they must come through unchanged.
    const db = databaseBeforeCurrencyCheck();
    const shape = () => ({
      indexes: db
        .query(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'registry_contributions' ORDER BY name",
        )
        .all(),
      foreignKeys: db
        .query(
          'SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(\'registry_contributions\') ORDER BY "from"',
        )
        .all(),
      otherTables: db
        .query(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'registry_contributions' ORDER BY type, name",
        )
        .all(),
    });
    const before = shape();
    expect(before.indexes).toHaveLength(6);
    expect(before.foreignKeys).toHaveLength(3);
    apply(db, MIG_CURRENCY_CHECK);
    expect(shape()).toEqual(before);
    db.close();
  });

  it("keeps every gift, and every column of it", () => {
    const db = seeded();
    const before = gifts(db);
    expect(before.map((row) => row.id)).toEqual(["rct_full", "rct_sparse"]);
    apply(db, MIG_CURRENCY_CHECK);
    expect(gifts(db)).toEqual(before);
    db.close();
  });

  it("refuses a currency that is not three characters, in either case", () => {
    const db = seeded();
    apply(db, MIG_CURRENCY_CHECK);
    for (const [id, currency] of [
      ["rct_two", "AU"],
      ["rct_four", "AUDD"],
      ["rct_empty", ""],
    ] as const) {
      expect(() => give(db, id, currency, null)).toThrow(
        "CHECK constraint failed: registry_contributions_currency_ck",
      );
    }
    expect(() =>
      db.exec("UPDATE registry_contributions SET currency = 'AUDD' WHERE id = 'rct_sparse'"),
    ).toThrow("CHECK constraint failed: registry_contributions_currency_ck");

    give(db, "rct_upper", "AUD", null);
    give(db, "rct_lower", "aud", null);
    expect(
      db
        .query("SELECT id FROM registry_contributions WHERE id IN ('rct_upper', 'rct_lower')")
        .all(),
    ).toHaveLength(2);
    db.close();
  });

  it("refuses a primary currency that is neither NULL nor three characters", () => {
    const db = seeded();
    apply(db, MIG_CURRENCY_CHECK);
    for (const [id, primary] of [
      ["rct_two", "US"],
      ["rct_four", "USDX"],
    ] as const) {
      expect(() => give(db, id, "AUD", primary)).toThrow(
        "CHECK constraint failed: registry_contributions_primary_currency_ck",
      );
    }

    give(db, "rct_none", "AUD", null);
    give(db, "rct_usd", "AUD", "usd");
    expect(
      db.query("SELECT id FROM registry_contributions WHERE id IN ('rct_none', 'rct_usd')").all(),
    ).toHaveLength(2);
    db.close();
  });

  it("refuses to apply over a stored gift whose currency breaks a check", () => {
    for (const [column, value, check] of [
      ["currency", "AU", "registry_contributions_currency_ck"],
      ["primary_currency", "USDX", "registry_contributions_primary_currency_ck"],
    ] as const) {
      const db = seeded();
      db.exec(`UPDATE registry_contributions SET ${column} = '${value}' WHERE id = 'rct_sparse'`);
      expect(() => apply(db, MIG_CURRENCY_CHECK)).toThrow(`CHECK constraint failed: ${check}`);
      db.close();
    }
  });
});
