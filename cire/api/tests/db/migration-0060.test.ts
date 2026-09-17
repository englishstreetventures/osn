import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Data-preservation proof for migration 0060 (the helper role + the per-helper
// run-sheet scope). Structural lockstep is ddl-lockstep.test.ts's job; what
// this replays is the one thing a structural diff cannot see — what happens to
// a co-host seat that already existed when the column arrived.
//
// The scope defaults CLOSED, so the answer has to be that every pre-0060 seat
// comes out `own`. A seat that back-filled to `full` would hand the whole run
// sheet to every helper converted from an existing seat, which is precisely the
// direction this column exists to prevent.
//
// Reads cire/db/migrations/, not migrations-archive/: 0060 sits on the live
// baseline (0001_initial + 0058 + 0059), and those are the files wrangler applies.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const MIG_0060 = "0060_helper_role_and_run_sheet_scope.sql";

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

/** The chain as it stood before 0060. */
function applyBaseline(db: Database): void {
  apply(db, "0001_initial.sql");
  apply(db, "0058_gift_summary_and_stripe_state.sql");
  apply(db, "0059_rsvp_dietary_presets.sql");
}

function seedSeats(db: Database): void {
  db.exec(
    "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
      " VALUES ('wed_1', 'w1', 'W1', 'usr_owner', 0, 0);",
  );
  db.exec(
    "INSERT INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, created_at)" +
      " VALUES ('whost_1', 'wed_1', 'usr_ed', 'usr_owner', 'editor', 0)," +
      " ('whost_2', 'wed_1', 'usr_vi', 'usr_owner', 'viewer', 0)," +
      " ('whost_3', 'wed_1', 'usr_legacy', 'usr_owner', 'host', 0);",
  );
}

type SeatRow = { id: string; role: string; run_sheet_scope: string };

describe("migration 0060", () => {
  it("back-fills every pre-existing seat to run_sheet_scope 'own', the closed value", () => {
    const db = new Database(":memory:");
    applyBaseline(db);
    seedSeats(db);
    apply(db, MIG_0060);

    const rows = db
      .query("SELECT id, role, run_sheet_scope FROM wedding_hosts ORDER BY id")
      .all() as SeatRow[];
    expect(rows).toEqual([
      { id: "whost_1", role: "editor", run_sheet_scope: "own" },
      { id: "whost_2", role: "viewer", run_sheet_scope: "own" },
      { id: "whost_3", role: "host", run_sheet_scope: "own" },
    ]);
    db.close();
  });

  it("leaves every pre-existing seat's role untouched", () => {
    const db = new Database(":memory:");
    applyBaseline(db);
    seedSeats(db);
    const before = db.query("SELECT id, role FROM wedding_hosts ORDER BY id").all();
    apply(db, MIG_0060);
    expect(db.query("SELECT id, role FROM wedding_hosts ORDER BY id").all()).toEqual(before);
    db.close();
  });

  it("gives a seat inserted after 0060 without a scope the closed value too", () => {
    const db = new Database(":memory:");
    applyBaseline(db);
    seedSeats(db);
    apply(db, MIG_0060);
    db.exec(
      "INSERT INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, created_at)" +
        " VALUES ('whost_4', 'wed_1', 'usr_help', 'usr_owner', 'helper', 0);",
    );
    const [row] = db
      .query("SELECT run_sheet_scope FROM wedding_hosts WHERE id = 'whost_4'")
      .all() as { run_sheet_scope: string }[];
    expect(row!.run_sheet_scope).toBe("own");
    db.close();
  });

  it("accepts 'helper' in the role column — no CHECK constraint stands in the way", () => {
    // The enum is app-layer; the column is plain TEXT. This pins that the
    // migration did not need to rebuild the table to admit the new value, which
    // is what makes 0060 a one-line ALTER rather than a copy-and-swap.
    const db = new Database(":memory:");
    applyBaseline(db);
    seedSeats(db);
    apply(db, MIG_0060);
    db.exec(
      "INSERT INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, run_sheet_scope, created_at)" +
        " VALUES ('whost_5', 'wed_1', 'usr_help2', 'usr_owner', 'helper', 'full', 0);",
    );
    const [row] = db
      .query("SELECT role, run_sheet_scope FROM wedding_hosts WHERE id = 'whost_5'")
      .all() as SeatRow[];
    expect(row).toMatchObject({ role: "helper", run_sheet_scope: "full" });
    db.close();
  });
});
