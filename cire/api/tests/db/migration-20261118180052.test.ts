import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

// Proof for migration 20261118180052_gifts_keep_their_account.
//
// `registry_contributions` gains the account a gift was paid into and its
// type, back-filled from the wedding's settings row only where that row's
// account is certainly the one the gift was made on: created after the last
// clear of an account (`stripe_deauthorized_at`, Stripe's event time) and not
// before the current account was connected (`stripe_connected_at`). Every
// other gift stays NULL, which the webhook matches through the wedding's
// current account, as before the column.
//
// `registry_settings` gains `stripe_account_generation`, which a trigger
// raises by one each time the account id goes from a value to NULL, and a
// second trigger copies the wedding's account onto a gift inserted without one
// (a Worker from before this migration). The D1 replay of the chain is in
// d1-integration.test.ts.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG = "20261118180052_gifts_keep_their_account.sql";

/** A file as wrangler sends it, one statement at a time. */
function apply(db: Database, file: string): void {
  for (const statement of migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))) {
    db.exec(statement);
  }
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

function migrated(): Database {
  const db = databaseBefore();
  apply(db, MIG);
  return db;
}

function wedding(db: Database, id: string): void {
  db.query(
    "INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
  ).run(id, id, id);
  db.query(
    "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES (?, ?, ?, 'Guest', 1, 1)",
  ).run(`fam_${id}`, id, `PUB-${id}`);
}

function settings(
  db: Database,
  weddingId: string,
  row: {
    account: string | null;
    type?: "express" | "standard" | null;
    connectedAt?: number | null;
    deauthorizedAt?: number | null;
  },
): void {
  db.query(
    `INSERT INTO registry_settings
       (wedding_id, stripe_account_id, stripe_account_type, stripe_connected_at,
        stripe_deauthorized_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(
    weddingId,
    row.account,
    row.type ?? null,
    row.connectedAt ?? null,
    row.deauthorizedAt ?? null,
  );
}

/**
 * A gift on the wedding's one household, created at `createdAt` (epoch
 * seconds), with a Checkout session unless `session` is false: an attempt
 * Stripe refused (as it refuses any session on a deauthorized account) has
 * none.
 */
function gift(
  db: Database,
  id: string,
  weddingId: string,
  createdAt: number,
  session = true,
): void {
  db.query(
    `INSERT INTO registry_contributions
       (id, wedding_id, family_id, status, amount_minor, currency,
        stripe_checkout_session_id, created_at, updated_at)
     VALUES (?, ?, ?, 'succeeded', 5000, 'AUD', ?, ?, ?)`,
  ).run(id, weddingId, `fam_${weddingId}`, session ? `cs_${id}` : null, createdAt, createdAt);
}

type GiftAccount = { id: string; account: string | null; type: string | null };

function giftAccounts(db: Database): GiftAccount[] {
  return db
    .query(
      "SELECT id, stripe_account_id AS account, stripe_account_type AS type FROM registry_contributions ORDER BY id",
    )
    .all() as GiftAccount[];
}

function generation(db: Database, weddingId: string): number {
  const row = db
    .query("SELECT stripe_account_generation AS g FROM registry_settings WHERE wedding_id = ?")
    .get(weddingId) as { g: number } | null;
  if (!row) throw new Error(`no settings row for ${weddingId}`);
  return row.g;
}

describe("migration 20261118180052 — a gift keeps the account it was paid into", () => {
  it("gives a gift the wedding's account only where that account is certainly the one it was made on", () => {
    const db = databaseBefore();

    // Never cleared, connected before the column existed: every gift was
    // made on the account the row names, and keeps its stored type, NULL
    // included (it reads as Express, as it does on the settings row).
    wedding(db, "wed_old");
    settings(db, "wed_old", { account: "acct_old" });
    gift(db, "g_old_1", "wed_old", 100);
    gift(db, "g_old_2", "wed_old", 5000);

    // Never cleared, a Standard account connected at 1000.
    wedding(db, "wed_std");
    settings(db, "wed_std", { account: "acct_std", type: "standard", connectedAt: 1000 });
    gift(db, "g_std_1", "wed_std", 1000);
    gift(db, "g_std_2", "wed_std", 4000);

    // Lost account A at Stripe's 2000; the clear landed later (Stripe
    // retries), and account B was attached at 2500. A gift before the
    // deauthorization, one in its second, and one between it and B's connect
    // were all made on A; only the one after B's connect is B's.
    wedding(db, "wed_moved");
    settings(db, "wed_moved", {
      account: "acct_b",
      type: "express",
      connectedAt: 2500,
      deauthorizedAt: 2000,
    });
    gift(db, "g_moved_before", "wed_moved", 1500);
    gift(db, "g_moved_same_second", "wed_moved", 2000);
    gift(db, "g_moved_window", "wed_moved", 2200);
    gift(db, "g_moved_after", "wed_moved", 2600);

    // Lost account B at 3000, then reused A from another wedding, so A's
    // connect time is the source's 1000, earlier than B's gifts. Only the
    // deauthorization tells B's gifts apart, a gift in its second included.
    wedding(db, "wed_reused");
    settings(db, "wed_reused", {
      account: "acct_a",
      connectedAt: 1000,
      deauthorizedAt: 3000,
    });
    gift(db, "g_reused_b_1", "wed_reused", 2000);
    gift(db, "g_reused_b_2", "wed_reused", 2900);
    gift(db, "g_reused_b_same_second", "wed_reused", 3000);
    // Between B's deauthorization and its clear, which can land days later,
    // the row still named B: an attempt then was refused by Stripe and has no
    // session. A's connect time, copied from its source, cannot exclude it;
    // only a session made after the deauthorization is certainly A's.
    gift(db, "g_reused_window_refused", "wed_reused", 3200, false);
    gift(db, "g_reused_window_paid", "wed_reused", 3200);
    gift(db, "g_reused_a", "wed_reused", 3500);

    // No account now, and no settings row at all.
    wedding(db, "wed_none");
    settings(db, "wed_none", { account: null, deauthorizedAt: 2000 });
    gift(db, "g_none", "wed_none", 3000);
    wedding(db, "wed_bare");
    gift(db, "g_bare", "wed_bare", 3000);

    apply(db, MIG);

    expect(giftAccounts(db)).toEqual([
      { id: "g_bare", account: null, type: null },
      { id: "g_moved_after", account: "acct_b", type: "express" },
      { id: "g_moved_before", account: null, type: null },
      { id: "g_moved_same_second", account: null, type: null },
      { id: "g_moved_window", account: null, type: null },
      { id: "g_none", account: null, type: null },
      { id: "g_old_1", account: "acct_old", type: null },
      { id: "g_old_2", account: "acct_old", type: null },
      { id: "g_reused_a", account: "acct_a", type: null },
      { id: "g_reused_b_1", account: null, type: null },
      { id: "g_reused_b_2", account: null, type: null },
      { id: "g_reused_b_same_second", account: null, type: null },
      { id: "g_reused_window_paid", account: "acct_a", type: null },
      { id: "g_reused_window_refused", account: null, type: null },
      { id: "g_std_1", account: "acct_std", type: "standard" },
      { id: "g_std_2", account: "acct_std", type: "standard" },
    ]);
    // Every existing settings row starts at generation 0.
    expect(generation(db, "wed_moved")).toBe(0);
    db.close();
  });
});

describe("migration 20261118180052 — the generation counts each clear of an account", () => {
  it("adds one for a clear shaped like detachStripeAccount, which NULLs the type and connect time too", () => {
    const db = migrated();
    wedding(db, "wed_a");
    settings(db, "wed_a", { account: "acct_a", type: "standard", connectedAt: 1000 });
    db.exec(
      `UPDATE registry_settings
          SET stripe_account_id = NULL, stripe_connected_by_osn_profile_id = NULL,
              stripe_account_type = NULL, stripe_connected_at = NULL,
              stripe_deauthorized_account_id = 'acct_a', stripe_deauthorized_at = 2000,
              stripe_charges_enabled = 0, stripe_payouts_enabled = 0,
              stripe_account_updated_at = 2000, updated_at = 2000
        WHERE stripe_account_id = 'acct_a'`,
    );
    expect(generation(db, "wed_a")).toBe(1);
    db.close();
  });

  it("adds one for a bare clear of the id, which the cleared trigger finishes", () => {
    const db = migrated();
    wedding(db, "wed_a");
    settings(db, "wed_a", { account: "acct_a", type: "express", connectedAt: 1000 });
    db.exec("UPDATE registry_settings SET stripe_account_id = NULL WHERE wedding_id = 'wed_a'");
    expect(generation(db, "wed_a")).toBe(1);
    // The cleared trigger still runs beside it.
    expect(
      db
        .query(
          "SELECT stripe_account_type AS type, stripe_connected_at AS at FROM registry_settings WHERE wedding_id = 'wed_a'",
        )
        .get(),
    ).toEqual({ type: null, at: null });
    db.close();
  });

  it("adds one on each wedding when one statement clears an account two weddings share", () => {
    const db = migrated();
    wedding(db, "wed_a");
    wedding(db, "wed_b");
    settings(db, "wed_a", { account: "acct_shared", connectedAt: 1000 });
    settings(db, "wed_b", { account: "acct_shared", connectedAt: 1000 });
    db.exec(
      "UPDATE registry_settings SET stripe_account_id = NULL WHERE stripe_account_id = 'acct_shared'",
    );
    expect([generation(db, "wed_a"), generation(db, "wed_b")]).toEqual([1, 1]);
    db.close();
  });

  it("counts no fill, no refill and no write to another column", () => {
    const db = migrated();
    wedding(db, "wed_a");
    settings(db, "wed_a", { account: null });
    db.exec("UPDATE registry_settings SET stripe_account_id = 'acct_1' WHERE wedding_id = 'wed_a'");
    db.exec("UPDATE registry_settings SET stripe_account_id = 'acct_1' WHERE wedding_id = 'wed_a'");
    db.exec(
      "UPDATE registry_settings SET stripe_charges_enabled = 1, headline = 'Gifts' WHERE wedding_id = 'wed_a'",
    );
    // A clear of a row that already has no account is not a clear.
    db.exec("UPDATE registry_settings SET stripe_account_id = NULL WHERE wedding_id = 'wed_a'");
    db.exec("UPDATE registry_settings SET stripe_account_id = NULL WHERE wedding_id = 'wed_a'");
    expect(generation(db, "wed_a")).toBe(1);
    db.close();
  });
});

describe("migration 20261118180052 — a gift inserted without an account takes the wedding's", () => {
  it("copies the wedding's account and stored type, keeps one it was given, and leaves the rest NULL", () => {
    const db = migrated();
    wedding(db, "wed_std");
    settings(db, "wed_std", { account: "acct_std", type: "standard", connectedAt: 1000 });
    wedding(db, "wed_untyped");
    settings(db, "wed_untyped", { account: "acct_untyped" });
    wedding(db, "wed_none");
    settings(db, "wed_none", { account: null });
    wedding(db, "wed_bare");

    // What a Worker from before this migration writes: no account.
    gift(db, "g_std", "wed_std", 5000);
    gift(db, "g_untyped", "wed_untyped", 5000);
    gift(db, "g_none", "wed_none", 5000);
    gift(db, "g_bare", "wed_bare", 5000);
    // What this Worker writes: the account the gate read, which stays.
    db.query(
      `INSERT INTO registry_contributions
         (id, wedding_id, family_id, status, amount_minor, currency,
          stripe_account_id, stripe_account_type, created_at, updated_at)
       VALUES ('g_given', 'wed_std', 'fam_wed_std', 'pending', 5000, 'AUD', 'acct_given', 'express', 5000, 5000)`,
    ).run();

    expect(giftAccounts(db)).toEqual([
      { id: "g_bare", account: null, type: null },
      { id: "g_given", account: "acct_given", type: "express" },
      { id: "g_none", account: null, type: null },
      { id: "g_std", account: "acct_std", type: "standard" },
      { id: "g_untyped", account: "acct_untyped", type: null },
    ]);
    db.close();
  });
});
