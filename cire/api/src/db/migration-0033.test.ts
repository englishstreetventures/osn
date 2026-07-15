import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data-preservation + FK-integrity + invariant proof for migration 0033 (the
// `families` table rebuild that REVERSES 0032 — `public_id` back to NOT NULL +
// full column-level UNIQUE, dropping the partial index). Structural lockstep is
// covered by ddl-lockstep.test.ts (T-S1). This replays the chain around 0033
// with SEEDED rows across the whole families cascade subtree (guests, sessions,
// guest_events, rsvps, guest_account_links) and asserts:
//   1. every household row survives with its id + columns intact,
//   2. NO child is orphaned (every FK still resolves to its family),
//   3. `public_id` is NOT NULL and the partial `families_public_id_uniq` index is
//      GONE (a full, non-partial unique constraint enforces global uniqueness),
//   4. a duplicate code is rejected and a NULL code is rejected,
//   5. FAIL-LOUD: if a pre-existing code-less household (`public_id IS NULL`)
//      exists, the rebuild's copy INSERT fails the NOT NULL constraint and the
//      `__keep_*` snapshots survive for manual recovery — the migration refuses
//      to coerce/mint a placeholder, per its header note (a human must mint a
//      real code first).
//
// Note on execution model: `wrangler d1 migrations apply` (and production D1)
// runs each statement INDIVIDUALLY. bun:sqlite's `db.exec(wholeFile)` instead
// swallows a mid-string statement error and continues, so the fail-loud test
// below splits on `--> statement-breakpoint` and runs statement-by-statement —
// faithfully reproducing how D1 experiences (and aborts on) the NOT NULL row.

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();

const MIG_0033 = "0033_households_require_code.sql";

/** Apply the migration chain up to (but not including) `MIG_0033` onto `db`. */
function applyThrough0032(db: Database): void {
  for (const file of migrationFiles()) {
    if (file === MIG_0033) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

/** Run 0033 statement-by-statement (as `wrangler d1 migrations apply` does), so
 *  a mid-file failure propagates instead of being swallowed by a whole-file
 *  `exec`. Returns the 0-based index of the statement that threw, or -1. */
function apply0033PerStatement(db: Database): number {
  const statements = readFileSync(join(MIGRATIONS_DIR, MIG_0033), "utf8").split(
    "--> statement-breakpoint",
  );
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (stmt === "") continue;
    try {
      db.exec(stmt);
    } catch {
      return i;
    }
  }
  return -1;
}

describe("migration 0033: families rebuild (public_id back to NOT NULL + full unique)", () => {
  it("preserves every household + child row with no orphans after the rebuild", () => {
    const db = new Database(":memory:");
    // D1 enforces FKs unconditionally; replay under the same rule so the rebuild
    // must be FK-consistent exactly as production experiences it.
    db.exec("PRAGMA foreign_keys = ON;");
    applyThrough0032(db);

    // ── seed a pre-0033 world: a wedding, two coded households, a guest per
    //    household, an event, guest_events links, rsvps + a session and a
    //    guest_account_link so EVERY cascade child is represented ──────────────
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

    // ── run the rebuild (no NULL rows → clean apply) ─────────────────────────
    db.exec(readFileSync(join(MIGRATIONS_DIR, MIG_0033), "utf8"));

    // No __keep_* scratch tables left behind.
    const scratch = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__keep_%'")
      .all();
    expect(scratch).toEqual([]);

    // public_id is NOT NULL again (notnull = 1).
    const publicIdCol = (
      db.query("PRAGMA table_info('families')").all() as Array<{ name: string; notnull: number }>
    ).find((c) => c.name === "public_id");
    expect(publicIdCol?.notnull).toBe(1);

    // The partial `families_public_id_uniq` index (0032's) is GONE, replaced by a
    // full column-level UNIQUE (a non-partial autoindex covering public_id).
    const namedPartial = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='families' AND name='families_public_id_uniq'",
      )
      .all();
    expect(namedPartial).toEqual([]);
    const indexList = db.query("PRAGMA index_list('families')").all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const fullUniqueOnPublicId = indexList.some((idx) => {
      if (idx.unique !== 1 || idx.partial !== 0) return false;
      const cols = (
        db.query(`PRAGMA index_info('${idx.name}')`).all() as Array<{ name: string | null }>
      ).map((c) => c.name);
      return cols.length === 1 && cols[0] === "public_id";
    });
    expect(fullUniqueOnPublicId).toBe(true);

    // Every household survived, ids + codes intact.
    const fams = db
      .query("SELECT id, public_id, family_name FROM families ORDER BY id")
      .all() as Array<{ id: string; public_id: string | null; family_name: string }>;
    expect(fams).toEqual([
      { id: "fam_a", public_id: "SMITH-WIDGET-ABCDE", family_name: "Smith" },
      { id: "fam_b", public_id: "JONES-GADGET-FGHIJ", family_name: "Jones" },
    ]);

    // No orphans: every child still resolves to a families row.
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

    // The rsvp still resolves all the way up to its household — FK preservation.
    const chain = db
      .query(
        "SELECT f.family_name AS fam FROM rsvps r JOIN guests g ON r.guest_id = g.id JOIN families f ON g.family_id = f.id WHERE r.id = 'r_a'",
      )
      .get() as { fam: string } | null;
    expect(chain?.fam).toBe("Smith");

    db.close();
  });

  it("rejects a NULL code and a duplicate code after the rebuild", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (const file of migrationFiles()) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    db.exec(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES ('wed_1', 'w1', 'W1', 'usr_o', 0, 0);",
    );

    // A code is fine once…
    db.exec(
      "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)" +
        " VALUES ('fam_1', 'wed_1', 'SMITH-WIDGET-ABCDE', 'H', 0, 0);",
    );
    // …a duplicate code is rejected (full unique — no partial exemption anymore).
    expect(() =>
      db.exec(
        "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)" +
          " VALUES ('fam_2', 'wed_1', 'SMITH-WIDGET-ABCDE', 'H', 0, 0);",
      ),
    ).toThrow();
    // …and a NULL code is now rejected (NOT NULL restored — no code-less path).
    expect(() =>
      db.exec(
        "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)" +
          " VALUES ('fam_3', 'wed_1', NULL, 'H', 0, 0);",
      ),
    ).toThrow();

    db.close();
  });

  it("FAILS LOUDLY (does not coerce) if a pre-existing code-less household exists", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyThrough0032(db);
    db.exec(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES ('wed_1', 'w1', 'W1', 'usr_o', 0, 0);",
    );
    // 0032 permitted this code-less household; 0033 must REFUSE to migrate it
    // (a human must mint it a code first) rather than silently coerce a value.
    db.exec(
      "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)" +
        " VALUES ('fam_null', 'wed_1', NULL, 'Codeless', 0, 0);",
    );

    // Run statement-by-statement (as D1 does). The copy INSERT must fail the NOT
    // NULL constraint — statement index 6 in the file (after the five __keep_*
    // snapshots + the __new_families CREATE).
    const failedAt = apply0033PerStatement(db);
    expect(failedAt).toBeGreaterThanOrEqual(0);

    // Recovery property: the failure happens BEFORE `DROP TABLE families`, so the
    // original row is untouched AND the __keep_* snapshots survive on disk for a
    // human to recover from — nothing was coerced or lost.
    const stillThere = db.query("SELECT public_id FROM families WHERE id = 'fam_null'").get() as {
      public_id: string | null;
    } | null;
    expect(stillThere?.public_id).toBeNull();
    const keeps = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__keep_%'")
      .all() as Array<{ name: string }>;
    expect(keeps.length).toBe(5);

    db.close();
  });
});
