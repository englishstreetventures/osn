import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data-preservation + cascade proof for migration 0052 (the guest_events +
// rsvps rebuild that upgrades both event_id FKs from NO ACTION to CASCADE).
// Structural lockstep is covered by ddl-lockstep.test.ts; this replays the
// chain around 0052 with seeded rows and asserts:
//   1. every guest_events / rsvps row survives the copy with columns intact,
//   2. deleting an EVENT now cascades into both children (pre-0052 it threw
//      FOREIGN KEY constraint failed),
//   3. deleting a WEDDING cascades cleanly through BOTH branches (events and
//      families) — the landmine the migration exists to remove,
//   4. no __new_* / __keep_* scratch tables survive.

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();

const MIG_0052 = "0052_event_fk_cascade.sql";

function applyThrough(db: Database, stopBefore: string): void {
  for (const file of migrationFiles()) {
    if (file === stopBefore) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

function apply0052(db: Database): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, MIG_0052), "utf8"));
}

/** Seed a wedding with one family, one guest, two events, links + rsvps. */
function seedWorld(db: Database): void {
  db.exec(
    "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
      " VALUES ('wed_1', 'w1', 'W1', 'usr_o', 0, 0);",
  );
  db.exec(
    "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)" +
      " VALUES ('fam_1', 'wed_1', 'FAM-CODE-1', 'Fam', 0, 0);",
  );
  db.exec(
    "INSERT INTO guests (id, family_id, first_name, created_at, updated_at)" +
      " VALUES ('g_1', 'fam_1', 'Ada', 0, 0);",
  );
  db.exec(
    "INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone)" +
      " VALUES ('evt_1', 'wed_1', 'ceremony', 'Ceremony', 's', 'e', 'tz')," +
      " ('evt_2', 'wed_1', 'reception', 'Reception', 's', 'e', 'tz');",
  );
  db.exec(
    "INSERT INTO guest_events (guest_id, event_id) VALUES ('g_1', 'evt_1'), ('g_1', 'evt_2');",
  );
  db.exec(
    "INSERT INTO rsvps (id, guest_id, event_id, status, dietary, dietary_consent_at," +
      " dietary_consent_version, consent_source, created_at)" +
      " VALUES ('r_1', 'g_1', 'evt_1', 'attending', 'gf', 123, 'v1', 'guest', 456)," +
      " ('r_2', 'g_1', 'evt_2', 'declined', '', NULL, NULL, 'organiser_attested', 789);",
  );
}

describe("migration 0052: event_id FKs go NO ACTION → CASCADE", () => {
  it("preserves every child row byte-for-byte through the rebuild", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyThrough(db, MIG_0052);
    seedWorld(db);

    apply0052(db);

    const links = db
      .query("SELECT guest_id, event_id FROM guest_events ORDER BY event_id")
      .all() as { guest_id: string; event_id: string }[];
    expect(links).toEqual([
      { guest_id: "g_1", event_id: "evt_1" },
      { guest_id: "g_1", event_id: "evt_2" },
    ]);

    const rsvp = db.query("SELECT * FROM rsvps WHERE id = 'r_1'").get() as Record<string, unknown>;
    expect(rsvp).toMatchObject({
      guest_id: "g_1",
      event_id: "evt_1",
      status: "attending",
      dietary: "gf",
      dietary_consent_at: 123,
      dietary_consent_version: "v1",
      consent_source: "guest",
      created_at: 456,
    });

    const scratch = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '__new_%' OR name LIKE '__keep_%')",
      )
      .all();
    expect(scratch).toEqual([]);
  });

  it("event delete cascades into guest_events + rsvps (threw pre-0052)", () => {
    const pre = new Database(":memory:");
    pre.exec("PRAGMA foreign_keys = ON;");
    applyThrough(pre, MIG_0052);
    seedWorld(pre);
    expect(() => pre.exec("DELETE FROM events WHERE id = 'evt_1';")).toThrow();

    const post = new Database(":memory:");
    post.exec("PRAGMA foreign_keys = ON;");
    applyThrough(post, MIG_0052);
    seedWorld(post);
    apply0052(post);
    post.exec("DELETE FROM events WHERE id = 'evt_1';");
    const n = (row: unknown): number => (row as { n: number }).n;
    expect(
      n(post.query("SELECT COUNT(*) AS n FROM guest_events WHERE event_id='evt_1'").get()),
    ).toBe(0);
    expect(n(post.query("SELECT COUNT(*) AS n FROM rsvps WHERE event_id='evt_1'").get())).toBe(0);
    // The sibling event's children are untouched.
    expect(n(post.query("SELECT COUNT(*) AS n FROM rsvps").get())).toBe(1);
  });

  it("wedding delete cascades through the events branch (the 0052 landmine)", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyThrough(db, MIG_0052);
    seedWorld(db);
    apply0052(db);

    db.exec("DELETE FROM weddings WHERE id = 'wed_1';");
    const n = (row: unknown): number => (row as { n: number }).n;
    for (const table of ["families", "guests", "events", "guest_events", "rsvps"]) {
      expect(n(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get())).toBe(0);
    }
  });
});
