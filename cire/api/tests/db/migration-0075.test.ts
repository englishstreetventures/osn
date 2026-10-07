import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { databaseBefore } from "../test-helpers/archived-chain";

// Data proof for migration 0075, which appends the household member columns
// to `sessions`, `rsvps` and `rsvp_changes`. Rows seeded before it must
// survive untouched, and the two new references must SET NULL on a guest
// delete — drizzle-kit leaves `ON DELETE` out of an ADD COLUMN, so only a data
// test sees a missing hand edit.
//
// Reads cire/db/migrations-archive/: the live baseline already contains this
// migration, and replaying history is the point here.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations-archive");

const MIG_0075 = "0075_household_member_identity.sql";

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

/** A household of two with a session and a reply, as 0075 finds it. */
function beforeMigration(): Database {
  const db = databaseBefore(MIG_0075, { foreignKeys: true });
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)
      VALUES ('wed_1', 'w1', 'W', 'usr_1', 0, 0);
    INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone)
      VALUES ('evt_1', 'wed_1', 'dinner', 'Dinner', '', '', 'UTC');
    INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)
      VALUES ('fam_1', 'wed_1', 'CODE-0001', 'Sharma', 0, 0);
    INSERT INTO guests (id, family_id, first_name, created_at, updated_at)
      VALUES ('g_1', 'fam_1', 'Ada', 0, 0), ('g_2', 'fam_1', 'Ravi', 0, 0);
    INSERT INTO guest_events (guest_id, event_id) VALUES ('g_1', 'evt_1');
    INSERT INTO rsvps (id, guest_id, event_id, status, created_at)
      VALUES ('r_1', 'g_1', 'evt_1', 'attending', 0);
    INSERT INTO sessions (id, family_id, token, expires_at, created_at)
      VALUES ('s_1', 'fam_1', 'hash', 9999999999, 0);
  `);
  return db;
}

describe("migration 0075 — household member identity", () => {
  it("keeps existing rows, with no member, no sender and no link mark", () => {
    const db = beforeMigration();
    apply(db, MIG_0075);
    expect(db.query("SELECT member_guest_id AS m FROM sessions").get()).toEqual({ m: null });
    expect(
      db.query("SELECT submitted_by_guest_id AS s, submitted_via_link AS v FROM rsvps").get(),
    ).toEqual({ s: null, v: 0 });
  });

  it("nulls a deleted member's attribution and keeps the replies they sent", () => {
    const db = beforeMigration();
    apply(db, MIG_0075);
    db.exec(`
      UPDATE sessions SET member_guest_id = 'g_2';
      UPDATE rsvps SET submitted_by_guest_id = 'g_2', submitted_via_link = 1;
      DELETE FROM guests WHERE id = 'g_2';
    `);
    expect(db.query("SELECT member_guest_id AS m FROM sessions").get()).toEqual({ m: null });
    expect(db.query("SELECT guest_id AS g, submitted_by_guest_id AS s FROM rsvps").get()).toEqual({
      g: "g_1",
      s: null,
    });
  });

  it("still clears everything with the household", () => {
    const db = beforeMigration();
    apply(db, MIG_0075);
    db.exec(`
      UPDATE sessions SET member_guest_id = 'g_1';
      UPDATE rsvps SET submitted_by_guest_id = 'g_1';
      DELETE FROM families WHERE id = 'fam_1';
    `);
    const n = (table: string) =>
      (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(n("sessions")).toBe(0);
    expect(n("rsvps")).toBe(0);
    expect(n("guests")).toBe(0);
  });
});
