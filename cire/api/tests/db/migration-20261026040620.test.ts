import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

// Proof for migration 20261026040620_seating_plans, which adds seating plans:
// every event that has tables gets one selected plan, its tables and seats
// move into it, and two triggers put a table or seat written without a plan
// into one. The Worker before it writes exactly such rows, so its statements
// are replayed here, in the shapes it sends, against the migrated database.
// The D1 replay of the same file is in d1-integration.test.ts.
//
// It is a live migration, so the chain before it is the live directory: the
// baseline and everything after it, in the order wrangler runs them.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG_SEATING_PLANS = "20261026040620_seating_plans.sql";

/** A file as wrangler sends it, one statement at a time, so a statement
 *  SQLite refuses throws here. */
function statementsOf(file: string): readonly string[] {
  return migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function apply(db: Database, file: string): void {
  for (const statement of statementsOf(file)) db.exec(statement);
}

function applySeatingPlans(db: Database): void {
  apply(db, MIG_SEATING_PLANS);
}

function databaseBeforeSeatingPlans(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const chain = listMigrations(MIGRATIONS_DIR);
  const cut = chain.indexOf(MIG_SEATING_PLANS);
  expect(cut).toBeGreaterThan(0);
  for (const file of chain.slice(0, cut)) apply(db, file);
  return db;
}

/**
 * One wedding as the chain before the plans migration leaves it. The reception has two tables:
 * Ada and Bo at `stb_1`, Cy at `stb_2`. The ceremony has none. Dot is invited
 * to the reception and unseated.
 */
function seeded(): Database {
  const db = databaseBeforeSeatingPlans();
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_a', 'a', 'A', 1, 1);
    INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone, sort_order) VALUES
      ('evt_rec', 'wed_a', 'reception', 'Reception', '2027-03-01T18:00', '', 'UTC', 1),
      ('evt_cer', 'wed_a', 'ceremony', 'Ceremony', '2027-03-01T15:00', '', 'UTC', 0);
    INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES
      ('fam_a', 'wed_a', 'CODE-A', 'Alpha', 1, 1);
    INSERT INTO guests (id, family_id, first_name, last_name, sort_order, created_at, updated_at) VALUES
      ('g_ada', 'fam_a', 'Ada', '', 0, 1, 1),
      ('g_bo', 'fam_a', 'Bo', '', 1, 1, 1),
      ('g_cy', 'fam_a', 'Cy', '', 2, 1, 1),
      ('g_dot', 'fam_a', 'Dot', '', 3, 1, 1);
    INSERT INTO guest_events (guest_id, event_id) VALUES
      ('g_ada', 'evt_rec'), ('g_bo', 'evt_rec'), ('g_cy', 'evt_rec'), ('g_dot', 'evt_rec'),
      ('g_ada', 'evt_cer');
    INSERT INTO seating_tables (id, wedding_id, event_id, name, capacity, sort_order, created_at, updated_at) VALUES
      ('stb_1', 'wed_a', 'evt_rec', 'Table 1', 8, 0, 1, 1),
      ('stb_2', 'wed_a', 'evt_rec', 'Table 2', 8, 1, 1, 1);
    INSERT INTO seating_assignments (table_id, event_id, guest_id, created_at) VALUES
      ('stb_1', 'evt_rec', 'g_ada', 5), ('stb_1', 'evt_rec', 'g_bo', 6), ('stb_2', 'evt_rec', 'g_cy', 7);
  `);
  return db;
}

type Plan = { id: string; event_id: string; name: string; selected: number };
const plans = (db: Database): Plan[] =>
  db
    .query(
      "SELECT id, event_id, name, selected FROM seating_plans ORDER BY event_id, created_at, id",
    )
    .all() as Plan[];

type Seat = { table_id: string; plan_id: string | null; guest_id: string };
const seats = (db: Database): Seat[] =>
  db
    .query("SELECT table_id, plan_id, guest_id FROM seating_assignments ORDER BY guest_id, plan_id")
    .all() as Seat[];

const tablePlans = (db: Database): Array<{ id: string; plan_id: string | null }> =>
  db.query("SELECT id, plan_id FROM seating_tables ORDER BY id").all() as Array<{
    id: string;
    plan_id: string | null;
  }>;

/** A second plan at the reception, as the new API would write one: Ada at
 *  `stb_9`, Bo unseated. */
function addAlternative(db: Database): void {
  db.exec(`
    INSERT INTO seating_plans (id, wedding_id, event_id, name, selected, created_at, updated_at) VALUES
      ('spl_alt', 'wed_a', 'evt_rec', 'Alt', 0, 2, 2);
    INSERT INTO seating_tables (id, wedding_id, event_id, plan_id, name, capacity, sort_order, created_at, updated_at) VALUES
      ('stb_9', 'wed_a', 'evt_rec', 'spl_alt', 'Long', 20, 0, 2, 2);
    INSERT INTO seating_assignments (table_id, plan_id, event_id, guest_id, created_at) VALUES
      ('stb_9', 'spl_alt', 'evt_rec', 'g_ada', 2);
  `);
}

// The Worker before the plans migration, in the shapes it sends (cire/api/src/services/seating.ts
// before plans): every write names its columns without `plan_id`, and finds a
// seat by `(event_id, guest_id)`.
const oldWorker = {
  createTable: (db: Database, id: string, eventId: string) =>
    db.run(
      `INSERT INTO seating_tables (id, wedding_id, event_id, name, capacity, sort_order, created_at, updated_at)
       SELECT ?, events.wedding_id, events.id, 'Old', 8,
         coalesce((SELECT max(sort_order) FROM seating_tables WHERE event_id = ?), -1) + 1, 9, 9
       FROM events WHERE events.id = ? AND events.wedding_id = 'wed_a'
       RETURNING id`,
      [id, eventId, eventId],
    ),
  seatNew: (db: Database, tableId: string, eventId: string, guestId: string) =>
    db
      .query(
        `INSERT INTO seating_assignments (table_id, event_id, guest_id, created_at)
         SELECT ?, guest_events.event_id, guest_events.guest_id, 9 FROM guest_events
         WHERE guest_events.guest_id = ? AND guest_events.event_id = ?
           AND NOT EXISTS (SELECT 1 FROM seating_assignments e WHERE e.event_id = ? AND e.guest_id = ?)
         ON CONFLICT DO NOTHING RETURNING table_id`,
      )
      .all(tableId, guestId, eventId, eventId, guestId),
  move: (db: Database, tableId: string, eventId: string, guestId: string) =>
    db
      .query(
        `UPDATE seating_assignments SET table_id = ?
         WHERE event_id = ? AND guest_id = ? AND table_id <> ? RETURNING table_id`,
      )
      .all(tableId, eventId, guestId, tableId),
  unseat: (db: Database, eventId: string, guestId: string) =>
    db
      .query(
        "DELETE FROM seating_assignments WHERE event_id = ? AND guest_id = ? RETURNING table_id",
      )
      .all(eventId, guestId),
  chartTables: (db: Database, eventId: string) =>
    (
      db
        .query("SELECT id FROM seating_tables WHERE event_id = ? ORDER BY sort_order, id")
        .all(eventId) as Array<{ id: string }>
    ).map((t) => t.id),
};

describe("migration 20261026040620_seating_plans — one selected plan per event that has tables", () => {
  it("makes one selected Plan 1 for each event with tables, and none for an event without", () => {
    const db = seeded();
    applySeatingPlans(db);
    const rows = plans(db);
    expect(rows.map(({ event_id, name, selected }) => [event_id, name, selected])).toEqual([
      ["evt_rec", "Plan 1", 1],
    ]);
    expect(rows[0]?.id).toMatch(/^spl_[0-9a-f]{32}$/);
  });

  it("puts every table in its event's plan and keeps every seat at its table, in that plan", () => {
    const db = seeded();
    const before = db
      .query(
        "SELECT table_id, event_id, guest_id, created_at FROM seating_assignments ORDER BY guest_id",
      )
      .all();
    applySeatingPlans(db);
    const planId = plans(db)[0]!.id;
    expect(tablePlans(db)).toEqual([
      { id: "stb_1", plan_id: planId },
      { id: "stb_2", plan_id: planId },
    ]);
    expect(
      db
        .query(
          "SELECT table_id, event_id, guest_id, created_at FROM seating_assignments ORDER BY guest_id",
        )
        .all(),
    ).toEqual(before);
    expect(seats(db).every((seat) => seat.plan_id === planId)).toBe(true);
  });

  it("gives each event of each wedding its own plan, and each table and seat its own event's", () => {
    const db = seeded();
    // A second event of the same wedding with a table and a seat, and a second
    // wedding whose one event has a table and a seat.
    db.exec(`
      INSERT INTO seating_tables (id, wedding_id, event_id, name, capacity, sort_order, created_at, updated_at) VALUES
        ('stb_cer', 'wed_a', 'evt_cer', 'Front', 4, 0, 1, 1);
      INSERT INTO seating_assignments (table_id, event_id, guest_id, created_at) VALUES
        ('stb_cer', 'evt_cer', 'g_ada', 8);
      INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_b', 'b', 'B', 1, 1);
      INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone, sort_order) VALUES
        ('evt_b', 'wed_b', 'reception', 'B reception', '2027-05-01T18:00', '', 'UTC', 0);
      INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES
        ('fam_b', 'wed_b', 'CODE-B', 'Bravo', 1, 1);
      INSERT INTO guests (id, family_id, first_name, last_name, sort_order, created_at, updated_at) VALUES
        ('g_eve', 'fam_b', 'Eve', '', 0, 1, 1);
      INSERT INTO guest_events (guest_id, event_id) VALUES ('g_eve', 'evt_b');
      INSERT INTO seating_tables (id, wedding_id, event_id, name, capacity, sort_order, created_at, updated_at) VALUES
        ('stb_b', 'wed_b', 'evt_b', 'B table', 8, 0, 1, 1);
      INSERT INTO seating_assignments (table_id, event_id, guest_id, created_at) VALUES
        ('stb_b', 'evt_b', 'g_eve', 9);
    `);
    applySeatingPlans(db);
    const planRows = db
      .query("SELECT id, wedding_id, event_id, name, selected FROM seating_plans ORDER BY event_id")
      .all() as Array<Plan & { wedding_id: string }>;
    expect(
      planRows.map(({ wedding_id, event_id, name, selected }) => [
        wedding_id,
        event_id,
        name,
        selected,
      ]),
    ).toEqual([
      ["wed_b", "evt_b", "Plan 1", 1],
      ["wed_a", "evt_cer", "Plan 1", 1],
      ["wed_a", "evt_rec", "Plan 1", 1],
    ]);
    expect(new Set(planRows.map((p) => p.id)).size).toBe(3);
    const planOf = Object.fromEntries(planRows.map((p) => [p.event_id, p.id]));
    // Every table and every seat sits in the plan of its own event.
    expect(
      db
        .query(
          "SELECT count(*) AS n FROM seating_tables t JOIN seating_plans p ON p.id = t.plan_id WHERE p.event_id <> t.event_id OR p.wedding_id <> t.wedding_id",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(seats(db)).toEqual(
      [
        { table_id: "stb_1", plan_id: planOf.evt_rec, guest_id: "g_ada" },
        { table_id: "stb_cer", plan_id: planOf.evt_cer, guest_id: "g_ada" },
        { table_id: "stb_1", plan_id: planOf.evt_rec, guest_id: "g_bo" },
        { table_id: "stb_2", plan_id: planOf.evt_rec, guest_id: "g_cy" },
        { table_id: "stb_b", plan_id: planOf.evt_b, guest_id: "g_eve" },
      ].toSorted(
        (a, b) => a.guest_id.localeCompare(b.guest_id) || a.plan_id!.localeCompare(b.plan_id!),
      ),
    );
  });

  it("refuses a table that names a plan of another event or wedding, written or moved", () => {
    const db = seeded();
    db.exec(`
      INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_b', 'b', 'B', 1, 1);
      INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone, sort_order) VALUES
        ('evt_b', 'wed_b', 'reception', 'B reception', '2027-05-01T18:00', '', 'UTC', 0);
      INSERT INTO seating_tables (id, wedding_id, event_id, name, capacity, sort_order, created_at, updated_at) VALUES
        ('stb_b', 'wed_b', 'evt_b', 'B table', 8, 0, 1, 1);
    `);
    applySeatingPlans(db);
    const planOf = Object.fromEntries(plans(db).map((p) => [p.event_id, p.id]));
    db.run(
      "INSERT INTO seating_plans (id, wedding_id, event_id, name, selected, created_at, updated_at) VALUES ('spl_cer', 'wed_a', 'evt_cer', 'Plan 1', 1, 2, 2)",
    );
    const refused = /seating table plan is not a plan of its event/;
    for (const planId of ["spl_cer", planOf.evt_b!]) {
      expect(() =>
        db.run(
          "INSERT INTO seating_tables (id, wedding_id, event_id, plan_id, name, capacity, sort_order, created_at, updated_at) VALUES ('stb_x', 'wed_a', 'evt_rec', ?, 'X', 8, 9, 2, 2)",
          [planId],
        ),
      ).toThrow(refused);
      expect(() =>
        db.run("UPDATE seating_tables SET plan_id = ? WHERE id = 'stb_1'", [planId]),
      ).toThrow(refused);
    }
    expect(() =>
      db.run("UPDATE seating_tables SET event_id = 'evt_cer' WHERE id = 'stb_1'"),
    ).toThrow(refused);
    expect(tablePlans(db).find((t) => t.id === "stb_1")?.plan_id).toBe(planOf.evt_rec);
    // A table in a plan of its own event is taken.
    db.run(
      "INSERT INTO seating_tables (id, wedding_id, event_id, plan_id, name, capacity, sort_order, created_at, updated_at) VALUES ('stb_ok', 'wed_a', 'evt_cer', 'spl_cer', 'Ok', 8, 0, 2, 2)",
    );
  });

  it("swaps the one-seat-per-event index for one seat per plan, and keeps the invitation probe", () => {
    const db = seeded();
    applySeatingPlans(db);
    const indexes = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'seating_assignments' AND sql IS NOT NULL ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toEqual([
      "seating_assignments_event_guest_idx",
      "seating_assignments_plan_guest_uniq",
    ]);
    // The invitation's cascade still takes the seat.
    db.run("DELETE FROM guest_events WHERE guest_id = 'g_cy' AND event_id = 'evt_rec'");
    expect(seats(db).map((s) => s.guest_id)).toEqual(["g_ada", "g_bo"]);
  });
});

describe("migration 20261026040620_seating_plans — the Worker before it, on the migrated database", () => {
  it("seats, moves and unseats on an event with one plan, every row landing in that plan", () => {
    const db = seeded();
    applySeatingPlans(db);
    const planId = plans(db)[0]!.id;
    expect(oldWorker.seatNew(db, "stb_2", "evt_rec", "g_dot")).toEqual([{ table_id: "stb_2" }]);
    expect(oldWorker.move(db, "stb_2", "evt_rec", "g_ada")).toEqual([{ table_id: "stb_2" }]);
    expect(oldWorker.unseat(db, "evt_rec", "g_bo")).toEqual([{ table_id: "stb_1" }]);
    expect(seats(db)).toEqual([
      { table_id: "stb_2", plan_id: planId, guest_id: "g_ada" },
      { table_id: "stb_2", plan_id: planId, guest_id: "g_cy" },
      { table_id: "stb_2", plan_id: planId, guest_id: "g_dot" },
    ]);
  });

  it("puts a table it adds at an event with no plan into a new selected Plan 1, and seats there", () => {
    const db = seeded();
    applySeatingPlans(db);
    oldWorker.createTable(db, "stb_cer", "evt_cer");
    const cer = plans(db).filter((p) => p.event_id === "evt_cer");
    expect(cer.map(({ name, selected }) => [name, selected])).toEqual([["Plan 1", 1]]);
    expect(tablePlans(db).find((t) => t.id === "stb_cer")?.plan_id).toBe(cer[0]!.id);
    oldWorker.seatNew(db, "stb_cer", "evt_cer", "g_ada");
    expect(seats(db).find((s) => s.table_id === "stb_cer")?.plan_id).toBe(cer[0]!.id);
  });

  it("puts a table it adds at an event with plans into the selected one", () => {
    const db = seeded();
    applySeatingPlans(db);
    addAlternative(db);
    const selected = plans(db).find((p) => p.selected === 1)!;
    oldWorker.createTable(db, "stb_new", "evt_rec");
    expect(tablePlans(db).find((t) => t.id === "stb_new")?.plan_id).toBe(selected.id);
    expect(plans(db)).toHaveLength(2);
  });

  it("cannot seat a guest twice in one plan, whatever its own check misses", () => {
    const db = seeded();
    applySeatingPlans(db);
    // Its NOT EXISTS check, skipped: the plan's unique index refuses the row
    // the trigger writes the plan into, and the INSERT with it.
    expect(() =>
      db.run(
        "INSERT INTO seating_assignments (table_id, event_id, guest_id, created_at) VALUES ('stb_2', 'evt_rec', 'g_ada', 9)",
      ),
    ).toThrow(
      /UNIQUE constraint failed: seating_assignments\.plan_id, seating_assignments\.guest_id/,
    );
    expect(seats(db).filter((s) => s.guest_id === "g_ada")).toHaveLength(1);
  });

  it("with a second plan, mixes the plans' tables, clears every plan's seat, and cannot move a guest in both", () => {
    const db = seeded();
    applySeatingPlans(db);
    addAlternative(db);
    // Its chart lists every plan's tables as the event's.
    expect(oldWorker.chartTables(db, "evt_rec")).toEqual(["stb_1", "stb_9", "stb_2"]);
    // A move of a guest seated in both plans writes both rows onto one table,
    // and the alternative's row would leave its plan: the database refuses it,
    // by the primary key here and by the `(table_id, plan_id)` key otherwise.
    expect(() => oldWorker.move(db, "stb_2", "evt_rec", "g_ada")).toThrow(
      /UNIQUE constraint failed|FOREIGN KEY constraint failed/,
    );
    expect(
      seats(db)
        .filter((s) => s.guest_id === "g_ada")
        .map((s) => s.table_id)
        .toSorted(),
    ).toEqual(["stb_1", "stb_9"]);
    // An unseat clears the guest's seat in every plan.
    expect(oldWorker.unseat(db, "evt_rec", "g_ada")).toHaveLength(2);
    expect(seats(db).filter((s) => s.guest_id === "g_ada")).toEqual([]);
  });
});

describe("migration 20261026040620_seating_plans — the triggers' lookups", () => {
  it("reach each row by an index", () => {
    const db = seeded();
    applySeatingPlans(db);
    const plan = (sql: string) =>
      (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
        (row) => row.detail,
      );
    for (const sql of [
      "SELECT 1 FROM seating_plans WHERE event_id = 'evt_rec' AND selected = 1",
      "SELECT id FROM seating_plans WHERE event_id = 'evt_rec' AND selected = 1",
      "UPDATE seating_tables SET plan_id = 'x' WHERE id = 'stb_1'",
      "SELECT plan_id FROM seating_tables WHERE id = 'stb_1'",
      "UPDATE seating_assignments SET plan_id = 'x' WHERE table_id = 'stb_1' AND guest_id = 'g_ada'",
      "SELECT 1 FROM seating_plans WHERE id = 'x' AND event_id = 'evt_rec' AND wedding_id = 'wed_a'",
    ]) {
      expect(plan(sql).filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
    }
  });
});
