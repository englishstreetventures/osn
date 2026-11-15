import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listMigrations, migrationStatements } from "../../../scripts/migration-files";

// The migration that adds `users_one_default_per_account`, applied over rows
// an older database can hold: it settles each account to exactly one default
// before it builds the index, so it applies whatever the rows say, and the
// index then refuses a second default.

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "drizzle");
const FILE = "20261115121831_users_one_default_per_account.sql";

function apply(db: Database, file: string) {
  for (const stmt of migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))) {
    db.run(stmt);
  }
}

/** A database migrated up to, not including, the file under test. */
function before(): Database {
  const db = new Database(":memory:");
  for (const file of listMigrations(MIGRATIONS_DIR)) {
    if (file === FILE) break;
    apply(db, file);
  }
  return db;
}

function account(db: Database, id: string, profiles: [id: string, isDefault: 0 | 1, at: number][]) {
  db.run(
    "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    [id, `${id}@example.com`, `pk_${id}`],
  );
  for (const [profileId, isDefault, at] of profiles) {
    db.run(
      "INSERT INTO users (id, account_id, handle, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [profileId, id, profileId, isDefault, at, at],
    );
  }
}

function defaults(db: Database, accountId: string) {
  const rows = db
    .query("SELECT id, is_default FROM users WHERE account_id = ? ORDER BY id")
    .all(accountId) as { id: string; is_default: number }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.is_default]));
}

describe("the one-default-per-account migration", () => {
  it("leaves each account exactly one default, its oldest, and then refuses a second", () => {
    const db = before();
    account(db, "acc_two", [
      ["usr_two_newer", 1, 20],
      ["usr_two_older", 1, 10],
      ["usr_two_plain", 0, 5],
    ]);
    account(db, "acc_tie", [
      ["usr_tie_b", 1, 10],
      ["usr_tie_a", 1, 10],
    ]);
    account(db, "acc_none", [
      ["usr_none_newer", 0, 50],
      ["usr_none_older", 0, 30],
    ]);
    account(db, "acc_ok", [
      ["usr_ok_main", 1, 40],
      ["usr_ok_older", 0, 1],
    ]);

    apply(db, FILE);

    expect(defaults(db, "acc_two")).toEqual({
      usr_two_newer: 0,
      usr_two_older: 1,
      usr_two_plain: 0,
    });
    expect(defaults(db, "acc_tie")).toEqual({ usr_tie_a: 1, usr_tie_b: 0 });
    expect(defaults(db, "acc_none")).toEqual({ usr_none_newer: 0, usr_none_older: 1 });
    expect(defaults(db, "acc_ok")).toEqual({ usr_ok_main: 1, usr_ok_older: 0 });
    expect(() => db.run("UPDATE users SET is_default = 1 WHERE id = 'usr_ok_older'")).toThrow(
      /UNIQUE constraint failed/,
    );
  });
});
