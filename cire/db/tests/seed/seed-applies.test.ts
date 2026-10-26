import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";
import {
  DEV_OWNER_SEAT_ID,
  faqs,
  hosts,
  seatingPlans,
  seatingTables,
  seats,
} from "../../seed/data";
import { BOOTSTRAP_WEDDING_ID } from "../../src/schema";

// seed.test.ts proves dev-seed.sql is what the generator emits; this proves
// that SQL runs. It builds a database from the migration chain, applies the
// seed on top, and reads a block back, so a column list that no longer matches
// the schema fails here rather than on the dev deploy. A dev deploy never
// resets its database: it applies new migrations, then re-imports the seed
// whenever the file changes, on top of the rows already there.
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const SEED = new URL("../../seed/dev-seed.sql", import.meta.url);

function migrate(db: Database, files: readonly string[]): void {
  for (const file of files) {
    for (const statement of migrationStatements(readFileSync(new URL(file, MIGRATIONS), "utf8"))) {
      db.exec(statement);
    }
  }
}

function seededDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, listMigrations(fileURLToPath(MIGRATIONS)));
  db.exec(readFileSync(SEED, "utf8"));
  return db;
}

describe("dev-seed.sql against the migrated schema", () => {
  it("applies without error", () => {
    expect(() => seededDatabase()).not.toThrow();
  });

  it("seeds the invite FAQ in order, dated in epoch seconds", () => {
    const rows = seededDatabase()
      .query<{ id: string; question: string; sort_order: number; created_at: number }, []>(
        "SELECT id, question, sort_order, created_at FROM wedding_faqs ORDER BY sort_order, id",
      )
      .all();
    expect(rows.map((r) => [r.id, r.question, r.sort_order])).toEqual(
      faqs.map((f) => [f.id, f.question, f.sortOrder]),
    );
    for (const row of rows) {
      expect(Math.abs(row.created_at - Date.now() / 1000)).toBeLessThan(60);
    }
  });

  it("seeds the sample wedding on Crimson, comped by the seed", () => {
    // Dropping the tier from the seed would leave the column's Ivory default,
    // and every dev and preview wedding would then answer 402 on budget,
    // checklist, registry and vendors.
    const row = seededDatabase()
      .query<
        { tier: string; tier_source: string | null; tier_granted_by: string | null },
        [string]
      >("SELECT tier, tier_source, tier_granted_by FROM weddings WHERE id = ?")
      .get(BOOTSTRAP_WEDDING_ID);
    expect(row).toEqual({ tier: "crimson", tier_source: "comp", tier_granted_by: "dev-seed" });
  });
});

// The dev database held the seed's seating chart before seating plans existed:
// the tables and seats of the plan in use, since a chart then held one of each.
// The plans migration gave the Reception a plan of its own, with a random id,
// so the seed's plan in use is skipped there, and the seed's tables and seats
// must still import on top; the seed's other plans import as they are.
describe("dev-seed.sql over a chart the seating-plans migration moved", () => {
  const PLANS_MIGRATION = "20261026040620_seating_plans.sql";
  const inUse = seatingPlans.find((plan) => plan.selected)!.id;
  const chartTables = seatingTables.filter((t) => t.planId === inUse);
  const chartSeats = seats.filter((s) => s.planId === inUse);

  /** The seed without its "Seating chart" section: rule, title, rule, body. */
  function seedWithoutSeating(): string {
    const lines = readFileSync(SEED, "utf8").split("\n");
    const isRule = (line: string) => line.startsWith("-- ────");
    const title = lines.findIndex((line) => line.startsWith("-- Seating chart"));
    expect(title, "dev-seed.sql has no Seating chart section").toBeGreaterThan(0);
    const next = lines.findIndex((line, i) => i > title + 1 && isRule(line));
    expect(next, "no section follows Seating chart in dev-seed.sql").toBeGreaterThan(title);
    return [...lines.slice(0, title - 1), ...lines.slice(next)].join("\n");
  }

  function movedDatabase(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const files = listMigrations(fileURLToPath(MIGRATIONS));
    migrate(db, files.slice(0, files.indexOf(PLANS_MIGRATION)));
    db.exec(seedWithoutSeating());
    const now = Math.floor(Date.now() / 1000);
    for (const t of chartTables) {
      db.query(
        `INSERT INTO seating_tables (id, wedding_id, event_id, name, capacity, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(t.id, BOOTSTRAP_WEDDING_ID, t.eventId, t.name, t.capacity, t.sortOrder, now, now);
    }
    for (const s of chartSeats) {
      db.query(
        "INSERT INTO seating_assignments (table_id, event_id, guest_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(s.tableId, s.eventId, s.guestId, now);
    }
    migrate(db, files.slice(files.indexOf(PLANS_MIGRATION)));
    return db;
  }

  it("applies without error", () => {
    const db = movedDatabase();
    expect(() => db.exec(readFileSync(SEED, "utf8"))).not.toThrow();
  });

  it("leaves the tables on the migration's plan, and every seat on its table's plan", () => {
    const db = movedDatabase();
    const backfilled = db
      .query<{ id: string }, []>("SELECT id FROM seating_plans WHERE selected = 1")
      .all()
      .map((p) => p.id);
    db.exec(readFileSync(SEED, "utf8"));
    const planOf = (id: string) =>
      db
        .query<{ plan_id: string }, [string]>("SELECT plan_id FROM seating_tables WHERE id = ?")
        .get(id)?.plan_id;
    // The chart's tables stay on the migration's plan; the seed's other
    // plans bring their own tables.
    expect([...new Set(chartTables.map((t) => planOf(t.id)))]).toEqual(backfilled);
    for (const t of seatingTables.filter((table) => table.planId !== inUse)) {
      expect(planOf(t.id)).toBe(t.planId);
    }
    const strays = db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM seating_assignments a
         JOIN seating_tables t ON t.id = a.table_id
         WHERE a.plan_id IS NOT t.plan_id`,
      )
      .get();
    expect(strays?.n).toBe(0);
  });

  it("re-creates a deleted table on the migration's plan, and its seat on that table's plan", () => {
    const db = movedDatabase();
    const [backfilled] = db
      .query<{ id: string }, []>("SELECT id FROM seating_plans WHERE selected = 1")
      .all();
    const gone = chartTables[1]!.id;
    db.query("DELETE FROM seating_tables WHERE id = ?").run(gone);
    db.exec(readFileSync(SEED, "utf8"));
    const table = db
      .query<{ plan_id: string }, [string]>("SELECT plan_id FROM seating_tables WHERE id = ?")
      .get(gone);
    expect(table?.plan_id).toBe(backfilled?.id);
    const restored = db
      .query<{ plan_id: string }, [string]>(
        "SELECT plan_id FROM seating_assignments WHERE table_id = ?",
      )
      .all(gone);
    expect(restored).toEqual(
      seats.filter((s) => s.tableId === gone).map(() => ({ plan_id: backfilled!.id })),
    );
  });
});

// `scripts/cire-db-seed.sh` repoints the sample wedding's owner seat at a real
// account after seeding. Its SQL lives in a shell string, out of reach of the
// type checker, so this runs that string — variables filled in as the script
// fills them — against the seeded database.
describe("the seed script's owner repoint", () => {
  const script = readFileSync(
    new URL("../../../../scripts/cire-db-seed.sh", import.meta.url),
    "utf8",
  );

  function repointSql(profileId: string): string {
    const seatId = script.match(/OWNER_SEAT_ID="([^"]+)"/)?.[1];
    const command = script.match(/--command \\\n\s+"(DELETE FROM wedding_hosts[^"]+)"/)?.[1];
    expect(seatId, "could not read OWNER_SEAT_ID from cire-db-seed.sh").toBeTruthy();
    expect(command, "could not read the repoint SQL from cire-db-seed.sh").toBeTruthy();
    return command!
      .replaceAll("${CIRE_DEV_OWNER_PROFILE_ID}", profileId)
      .replaceAll("${OWNER_SEAT_ID}", seatId!);
  }

  type Seat = { id: string; osn_profile_id: string; role: string };
  const seatsOf = (db: Database) =>
    db
      .query<Seat, []>(
        "SELECT id, osn_profile_id, role FROM wedding_hosts WHERE wedding_id = 'wed_bootstrap' ORDER BY id",
      )
      .all();

  it("names the seed's own owner seat", () => {
    const seatId = script.match(/OWNER_SEAT_ID="([^"]+)"/)?.[1];
    expect(seatId).toBe(DEV_OWNER_SEAT_ID);
  });

  it("hands the owner seat to the given profile and leaves the wedding one owner", () => {
    const db = seededDatabase();
    db.exec(repointSql("usr_real_person"));
    const owners = seatsOf(db).filter((s) => s.role === "owner");
    expect(owners).toEqual([
      { id: DEV_OWNER_SEAT_ID, osn_profile_id: "usr_real_person", role: "owner" },
    ]);
  });

  it("drops any other seat the profile held first, so the unique seat index holds", () => {
    const db = seededDatabase();
    const cohost = hosts.find((h) => h.role === "editor")!;
    db.exec(repointSql(cohost.osnProfileId));
    const theirs = seatsOf(db).filter((s) => s.osn_profile_id === cohost.osnProfileId);
    expect(theirs).toEqual([
      { id: DEV_OWNER_SEAT_ID, osn_profile_id: cohost.osnProfileId, role: "owner" },
    ]);
  });
});
