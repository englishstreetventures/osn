import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data proof for migration 0066, which appends the plus-one columns to
// `guests`. It must be two ALTER TABLE ADDs and an index, never a rebuild:
// dropping `guests` under enforced foreign keys cascades into `rsvps`,
// `guest_events` and `guest_account_links`. Only rows seeded BEFORE the
// migration can tell the two apart, which the lockstep test cannot.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const MIG_0066 = "0066_plus_ones.sql";

const numberOf = (file: string): number => Number(file.slice(0, 4));

/** The live chain's files numbered in [from, to), in the order wrangler runs them. */
function chain(from: number, to: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .filter((f) => numberOf(f) >= from && numberOf(f) < to);
}

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

const count = (db: Database, table: string): number =>
  (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** The database as 0066 finds it: a household with a guest, an invitation and
 *  a reply, under enforced foreign keys. */
function beforeMigration(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of chain(1, 66)) apply(db, file);
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)
      VALUES ('wed_1', 'w1', 'W', 'usr_1', 0, 0);
    INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone)
      VALUES ('evt_1', 'wed_1', 'dinner', 'Dinner', '', '', 'UTC');
    INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)
      VALUES ('fam_1', 'wed_1', 'CODE-0001', 'Sharma', 0, 0);
    INSERT INTO guests (id, family_id, first_name, created_at, updated_at)
      VALUES ('g_1', 'fam_1', 'Ada', 0, 0);
    INSERT INTO guest_events (guest_id, event_id) VALUES ('g_1', 'evt_1');
    INSERT INTO rsvps (id, guest_id, event_id, status, created_at)
      VALUES ('r_1', 'g_1', 'evt_1', 'attending', 0);
  `);
  return db;
}

describe("migration 0066 — plus-ones", () => {
  it("keeps every existing guest, invitation and reply, with no permission and no inviter", () => {
    const db = beforeMigration();
    apply(db, MIG_0066);

    expect(count(db, "guests")).toBe(1);
    expect(count(db, "guest_events")).toBe(1);
    expect(count(db, "rsvps")).toBe(1);
    expect(
      db.query("SELECT plus_one_allowed, plus_one_of_guest_id FROM guests WHERE id = 'g_1'").get(),
    ).toEqual({ plus_one_allowed: 0, plus_one_of_guest_id: null });
  });

  it("removes a plus-one with the guest who brought them, and allows one per guest", () => {
    const db = beforeMigration();
    apply(db, MIG_0066);
    // `run`, not `exec`: bun's `exec` does not surface a constraint failure.
    const insertPlusOne = (id: string, name: string) =>
      db.run(
        "INSERT INTO guests (id, family_id, first_name, plus_one_of_guest_id, created_at, updated_at) VALUES (?, 'fam_1', ?, 'g_1', 0, 0)",
        [id, name],
      );
    insertPlusOne("g_plus", "Sam");
    expect(() => insertPlusOne("g_plus_2", "Pat")).toThrow(/UNIQUE/);

    db.run("DELETE FROM guests WHERE id = 'g_1'");
    expect(count(db, "guests")).toBe(0);
  });
});
