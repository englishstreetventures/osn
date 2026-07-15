import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data-preservation + FK-integrity proof for migration 0032 (the `families`
// table rebuild that makes `public_id` nullable). Structural lockstep is covered
// by ddl-lockstep.test.ts (T-S1); this replays the chain around 0032 with SEEDED
// rows across the whole families cascade subtree (guests, sessions, guest_events,
// rsvps, guest_account_links) and asserts:
//   1. every household row survives with its id + columns intact,
//   2. NO child is orphaned (every FK still resolves to its family),
//   3. the new partial unique index allows many code-less (NULL) households but
//      still rejects a duplicate NON-NULL code.

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();

/** Apply the migration chain [start, endExclusive) onto `db`. */
function applyRange(db: Database, files: string[], endBeforeTag: string): void {
  for (const file of files) {
    if (file === endBeforeTag) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

const MIG_0032 = "0032_households_nullable_code.sql";

describe("migration 0032: families rebuild (public_id nullable + partial unique)", () => {
  it("preserves every household + child row with no orphans after the rebuild", () => {
    const db = new Database(":memory:");
    // D1 enforces FKs unconditionally; replay under the same rule so the rebuild
    // must be FK-consistent exactly as production experiences it.
    db.exec("PRAGMA foreign_keys = ON;");
    const files = migrationFiles();
    const cut = files.indexOf(MIG_0032);
    expect(cut).toBeGreaterThan(0);

    // ── seed a pre-0032 world: a wedding, two households (each with a code), a
    //    guest per household, an event, guest_events links, rsvps + a session and
    //    a guest_account_link so EVERY cascade child is represented ─────────────
    applyRange(db, files, MIG_0032);

    db.exec(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES ('wed_1', 'w1', 'W1', 'usr_o', 0, 0);",
    );
    db.exec(
      "INSERT INTO families (id, wedding_id, public_id, family_name, kind, created_at, updated_at)" +
        " VALUES ('fam_a', 'wed_1', 'SMITH-WIDGET-ABCDE', 'Smith', 'guest', 1, 1)," +
        " ('fam_b', 'wed_1', 'JONES-GADGET-FGHIJ', 'Jones', 'guest', 2, 2);",
    );
    db.exec(
      "INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone)" +
        " VALUES ('evt_1', 'wed_1', 'e1', 'Ceremony', '2027-01-01T10:00', '', 'Australia/Sydney');",
    );
    db.exec(
      "INSERT INTO guests (id, family_id, first_name, last_name, sort_order, created_at, updated_at)" +
        " VALUES ('g_a', 'fam_a', 'Ann', 'Smith', 0, 1, 1), ('g_b', 'fam_b', 'Bob', 'Jones', 0, 2, 2);",
    );
    db.exec(
      "INSERT INTO guest_events (guest_id, event_id) VALUES ('g_a', 'evt_1'), ('g_b', 'evt_1');",
    );
    db.exec(
      "INSERT INTO rsvps (id, guest_id, event_id, status, dietary, created_at)" +
        " VALUES ('r_a', 'g_a', 'evt_1', 'attending', '', 1);",
    );
    db.exec(
      "INSERT INTO sessions (id, family_id, token, expires_at, created_at)" +
        " VALUES ('ses_a', 'fam_a', 'tok_a', 9999999999, 1);",
    );
    db.exec(
      "INSERT INTO guest_account_links (id, guest_id, family_id, wedding_id, osn_account_id, osn_profile_id, linked_at, updated_at)" +
        " VALUES ('gal_a', 'g_a', 'fam_a', 'wed_1', 'acc_1', 'prof_1', 1, 1);",
    );

    // ── run the rebuild ──────────────────────────────────────────────────────
    db.exec(readFileSync(join(MIGRATIONS_DIR, MIG_0032), "utf8"));

    // No __keep_* scratch tables left behind.
    const scratch = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__keep_%'")
      .all();
    expect(scratch).toEqual([]);

    // public_id is now nullable (notnull = 0).
    const publicIdCol = (
      db.query("PRAGMA table_info('families')").all() as Array<{ name: string; notnull: number }>
    ).find((c) => c.name === "public_id");
    expect(publicIdCol?.notnull).toBe(0);

    // Every household survived, ids + codes intact.
    const fams = db
      .query("SELECT id, public_id, family_name FROM families ORDER BY id")
      .all() as Array<{ id: string; public_id: string | null; family_name: string }>;
    expect(fams).toEqual([
      { id: "fam_a", public_id: "SMITH-WIDGET-ABCDE", family_name: "Smith" },
      { id: "fam_b", public_id: "JONES-GADGET-FGHIJ", family_name: "Jones" },
    ]);

    // No orphans: every child still resolves to a families row. A LEFT JOIN that
    // finds a NULL parent id would be an orphan.
    const orphanCount = (family: string) =>
      (
        db
          .query(
            `SELECT COUNT(*) AS n FROM ${family} c LEFT JOIN families f ON c.family_id = f.id WHERE f.id IS NULL`,
          )
          .get() as { n: number }
      ).n;
    expect(orphanCount("guests")).toBe(0);
    expect(orphanCount("sessions")).toBe(0);
    expect(orphanCount("guest_account_links")).toBe(0);
    // guest_events / rsvps FK to guests (not families) — check they resolve too.
    const orphanViaGuest = (child: string) =>
      (
        db
          .query(
            `SELECT COUNT(*) AS n FROM ${child} c LEFT JOIN guests g ON c.guest_id = g.id WHERE g.id IS NULL`,
          )
          .get() as { n: number }
      ).n;
    expect(orphanViaGuest("guest_events")).toBe(0);
    expect(orphanViaGuest("rsvps")).toBe(0);

    // The rsvp still resolves all the way up to its household.
    const chain = db
      .query(
        "SELECT f.family_name AS fam FROM rsvps r JOIN guests g ON r.guest_id = g.id JOIN families f ON g.family_id = f.id WHERE r.id = 'r_a'",
      )
      .get() as { fam: string } | null;
    expect(chain?.fam).toBe("Smith");

    db.close();
  });

  it("partial unique index allows many NULL codes but rejects a duplicate non-NULL code", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (const file of migrationFiles()) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    db.exec(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES ('wed_1', 'w1', 'W1', 'usr_o', 0, 0);",
    );

    // Three code-less households (public_id NULL) coexist — NULL is exempt.
    for (const id of ["fam_1", "fam_2", "fam_3"]) {
      db.exec(
        `INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)` +
          ` VALUES ('${id}', 'wed_1', NULL, 'H', 0, 0);`,
      );
    }
    const nullCount = (
      db.query("SELECT COUNT(*) AS n FROM families WHERE public_id IS NULL").get() as { n: number }
    ).n;
    expect(nullCount).toBe(3);

    // A non-NULL code is fine once…
    db.exec(
      "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)" +
        " VALUES ('fam_4', 'wed_1', 'SMITH-WIDGET-ABCDE', 'H', 0, 0);",
    );
    // …but a duplicate non-NULL code is rejected by the partial unique index.
    expect(() =>
      db.exec(
        "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)" +
          " VALUES ('fam_5', 'wed_1', 'SMITH-WIDGET-ABCDE', 'H', 0, 0);",
      ),
    ).toThrow();

    db.close();
  });
});
