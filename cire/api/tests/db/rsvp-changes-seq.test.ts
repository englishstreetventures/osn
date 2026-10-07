import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DDL } from "../../src/db/setup";

// `rsvp_changes.seq` is the cursor the portal feed and the daily digest keep.
// It must be AUTOINCREMENT: a plain INTEGER PRIMARY KEY hands the newest
// deleted number out again, and a reused seq sits at or below a cursor that
// already passed it, so the new change reads as seen. The lockstep test reads
// `PRAGMA table_info`, which cannot see AUTOINCREMENT, so this pins it on both
// surfaces the database is built from: the baseline migration a fresh D1 runs,
// and the test DDL mirror.

const MIGRATION = join(import.meta.dir, "..", "..", "..", "db", "migrations", "0001_initial.sql");

function createStatementFor(sqlText: string, table: string): string {
  const match = new RegExp(`CREATE TABLE[^(]*\\b${table}\\b[^(]*\\(([\\s\\S]*?)\\n\\);`, "i").exec(
    sqlText,
  );
  if (!match) throw new Error(`no CREATE TABLE for ${table}`);
  return match[0];
}

describe("rsvp_changes.seq", () => {
  it("is AUTOINCREMENT in the migration", () => {
    const create = createStatementFor(readFileSync(MIGRATION, "utf8"), "rsvp_changes");
    expect(create).toMatch(/`seq` integer PRIMARY KEY AUTOINCREMENT/i);
  });

  it("is AUTOINCREMENT in the test DDL mirror", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const row = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rsvp_changes'",
      )
      .get();
    expect(row?.sql).toMatch(/seq INTEGER PRIMARY KEY AUTOINCREMENT/i);
  });

  it("never reuses a number after the newest row is deleted", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(DDL);
    const insert = db.query(
      "INSERT INTO rsvp_changes (wedding_id, family_id, guest_id, event_id, kind, created_at) VALUES ('w', 'f', 'g', 'e', 'reply_new', 0) RETURNING seq",
    );
    const first = (insert.get() as { seq: number }).seq;
    const second = (insert.get() as { seq: number }).seq;
    db.exec(`DELETE FROM rsvp_changes WHERE seq = ${second}`);
    const third = (insert.get() as { seq: number }).seq;
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});
