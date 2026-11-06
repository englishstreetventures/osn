import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

// Proof for migration 20261106103949_platform_refunds, which adds the refund
// record and gives every purchase already in a refund cire made its record.
// Without one, the daily reconciliation would never retry a refused refund,
// `refund.failed` would find nothing, and the purge, which no longer waits on
// a refund, would delete the only row that says money is owed back.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG = "20261106103949_platform_refunds.sql";

function apply(db: Database, file: string): void {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  for (const statement of migrationStatements(sql)) db.exec(statement);
}

function databaseBefore(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const chain = listMigrations(MIGRATIONS_DIR);
  const cut = chain.indexOf(MIG);
  expect(cut).toBeGreaterThan(0);
  for (const file of chain.slice(0, cut)) apply(db, file);
  return db;
}

describe("migration 20261106103949_platform_refunds", () => {
  it("records each refund already under way, and nothing else", () => {
    const db = databaseBefore();
    db.exec(`
      INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_a', 'a', 'A', 1, 1);
      INSERT INTO wedding_upgrade_purchases
        (id, wedding_id, entitlement, from_tier, status, checkout_session_id, payment_intent_id,
         amount_minor, currency, refund_id, created_by_osn_profile_id, created_at, updated_at)
      VALUES
        ('upg_owed', 'wed_a', 'gold', 'ivory', 'refunding', 'cs_1', 'pi_1', 4900, 'AUD', NULL, 'usr_a', 1, 10),
        ('upg_back', 'wed_a', 'gold', 'ivory', 'auto_refunded', 'cs_2', 'pi_2', 4900, 'AUD', 're_2', 'usr_a', 1, 20),
        ('upg_person', 'wed_a', 'gold', 'ivory', 'refund_failed', 'cs_3', 'pi_3', 4900, 'AUD', NULL, 'usr_a', 1, 30),
        ('upg_sold', 'wed_a', 'gold', 'ivory', 'succeeded', 'cs_4', 'pi_4', 4900, 'AUD', NULL, 'usr_a', 1, 40),
        ('upg_by_hand', 'wed_a', 'gold', 'ivory', 'refunded', 'cs_5', 'pi_5', 4900, 'AUD', NULL, 'usr_a', 1, 50);
    `);

    apply(db, MIG);

    expect(
      db
        .query(
          "SELECT id, purchase_id, payment_intent_id, amount_minor, currency, reason, status, refund_id, owners_notified_at, created_at, updated_at FROM platform_refunds ORDER BY purchase_id",
        )
        .all(),
    ).toEqual([
      {
        id: "rfd_upg_back",
        purchase_id: "upg_back",
        payment_intent_id: "pi_2",
        amount_minor: 4900,
        currency: "AUD",
        reason: "unrecorded",
        status: "auto_refunded",
        refund_id: "re_2",
        owners_notified_at: null,
        created_at: 20,
        updated_at: 20,
      },
      {
        id: "rfd_upg_owed",
        purchase_id: "upg_owed",
        payment_intent_id: "pi_1",
        amount_minor: 4900,
        currency: "AUD",
        reason: "unrecorded",
        status: "refunding",
        refund_id: null,
        owners_notified_at: null,
        created_at: 10,
        updated_at: 10,
      },
      {
        id: "rfd_upg_person",
        purchase_id: "upg_person",
        payment_intent_id: "pi_3",
        amount_minor: 4900,
        currency: "AUD",
        reason: "unrecorded",
        status: "refund_failed",
        refund_id: null,
        owners_notified_at: null,
        created_at: 30,
        updated_at: 30,
      },
    ]);
  });
});
