/**
 * `jsonEachIn` and `insertManyViaJsonEach` exist to keep a variable-length
 * `IN (...)` or a multi-row `INSERT` under D1's 100-bound-parameter cap
 * (developers.cloudflare.com/d1/platform/limits/) by binding the whole
 * array as one JSON parameter instead of one parameter per element.
 * bun:sqlite enforces no such cap, so these tests can't reproduce the
 * failure the helpers fix — they pin the contract that makes the fix work
 * (constant parameter count regardless of input size, correct round-trip
 * data) via `.toSQL()`, which never executes a query. The real-D1 proof —
 * that json_each is accepted and returns the right rows on Miniflare/
 * workerd D1, not just bun:sqlite — lives in `pulse/api`'s
 * `d1-integration.test.ts`.
 */

import { Database } from "bun:sqlite";

import { getTableColumns, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { insertManyViaJsonEach, jsonEachIn } from "../src/jsonEach";

// A throwaway 4-column fixture table — enough columns to prove the
// per-column, per-row math without dragging in a real app schema.
const widgets = sqliteTable("widgets", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  ownerId: text("owner_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/** A second table for the guard tests: `widgets` has no plain integer column
 *  to push past 2^53, and a blob column would break its other tests. */
const guardTable = sqliteTable("guard_rows", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  count: integer("count"),
});

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(
    "CREATE TABLE widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL, owner_id TEXT, created_at INTEGER NOT NULL)",
  );
  return drizzle(sqlite, { schema: { widgets } });
}

describe("jsonEachIn", () => {
  it("binds exactly one parameter no matter how many ids are in the list", () => {
    const db = makeDb();
    for (const size of [1, 50, 100, 1_000]) {
      const ids = Array.from({ length: size }, (_, i) => `id_${i}`);
      const built = db
        .select()
        .from(widgets)
        .where(inArray(widgets.id, jsonEachIn(ids)))
        .toSQL();
      expect(built.params).toHaveLength(1);
      expect(built.sql).toContain("json_each");
    }
  });

  it("round-trips the id list correctly against a real (bun:sqlite) engine", () => {
    const db = makeDb();
    const now = new Date();
    db.insert(widgets)
      .values([
        { id: "a", label: "A", ownerId: null, createdAt: now },
        { id: "b", label: "B", ownerId: null, createdAt: now },
        { id: "c", label: "C", ownerId: null, createdAt: now },
      ])
      .run();

    const rows = db
      .select({ id: widgets.id })
      .from(widgets)
      .where(inArray(widgets.id, jsonEachIn(["a", "c", "does-not-exist"])))
      .all();
    expect(rows.map((r) => r.id).toSorted()).toEqual(["a", "c"]);
  });

  it("matches nothing for an empty list, same as inArray(col, [])", () => {
    const db = makeDb();
    const built = db
      .select()
      .from(widgets)
      .where(inArray(widgets.id, jsonEachIn([])))
      .toSQL();
    expect(built.params).toHaveLength(1);

    db.insert(widgets).values({ id: "a", label: "A", ownerId: null, createdAt: new Date() }).run();
    const rows = db
      .select({ id: widgets.id })
      .from(widgets)
      .where(inArray(widgets.id, jsonEachIn([])))
      .all();
    expect(rows).toHaveLength(0);
  });

  it("reusing one jsonEachIn(...) call across two predicates binds it twice, not once (osn-tracker#592 shape)", () => {
    // discovery.ts's friends filter splices the same connectionIds set into
    // two branches of one `or(...)` — this is that shape reduced to the
    // fixture table. 2 total params (not 2×N) either way: the fix is
    // binding the array once per *occurrence*, never once per *element*.
    const db = makeDb();
    const idsJson = jsonEachIn(["a", "b"]);
    const built = db
      .select()
      .from(widgets)
      .where(or(inArray(widgets.id, idsJson), inArray(widgets.ownerId, idsJson)))
      .toSQL();
    expect(built.params).toHaveLength(2);
  });
});

describe("insertManyViaJsonEach", () => {
  const now = new Date(1_700_000_000_000);

  it("binds exactly one parameter no matter how many rows or columns", () => {
    const db = makeDb();
    for (const rowCount of [1, 4, 260, 1_000]) {
      const rows = Array.from({ length: rowCount }, (_, i) => ({
        id: `w_${i}`,
        label: `Widget ${i}`,
        ownerId: null,
        createdAt: now,
      }));
      const built = (
        db as unknown as { dialect: { sqlToQuery: (s: unknown) => { params: unknown[] } } }
      ).dialect.sqlToQuery(insertManyViaJsonEach(widgets, rows));
      expect(built.params).toHaveLength(1);
    }
  });

  it("derives the fixed insertManyViaJsonEach param count against the scaling .values(rows) count", () => {
    // The regression this guards: `.values(rows)` binds columns × rows
    // parameters (derived here from the row's own key count, never
    // hard-coded), which is exactly what crosses D1's 100-parameter cap.
    // `insertManyViaJsonEach` stays at 1 regardless.
    const db = makeDb();
    const columnCount = Object.keys(getTableColumns(widgets)).length;
    const rowCount = 30;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `w_${i}`,
      label: `Widget ${i}`,
      ownerId: null,
      createdAt: now,
    }));

    const oldStyle = db.insert(widgets).values(rows).toSQL();
    expect(oldStyle.params).toHaveLength(columnCount * rowCount);
    expect(oldStyle.params.length).toBeGreaterThan(100); // this is the bug

    const built = (
      db as unknown as { dialect: { sqlToQuery: (s: unknown) => { params: unknown[] } } }
    ).dialect.sqlToQuery(insertManyViaJsonEach(widgets, rows));
    expect(built.params).toHaveLength(1);
  });

  it("round-trips rows correctly, including null and boolean-mapped values", () => {
    const db = makeDb();
    const rows = [
      { id: "a", label: 'Hello "quotes"', ownerId: "owner_1", createdAt: now },
      { id: "b", label: "Row 2", ownerId: null, createdAt: new Date(now.getTime() + 1_000) },
    ];
    db.run(insertManyViaJsonEach(widgets, rows));

    const back = db.select().from(widgets).orderBy(widgets.id).all();
    expect(back).toEqual([
      { id: "a", label: 'Hello "quotes"', ownerId: "owner_1", createdAt: now },
      { id: "b", label: "Row 2", ownerId: null, createdAt: new Date(now.getTime() + 1_000) },
    ]);
  });

  it("throws on an empty row set rather than emitting a no-op insert", () => {
    expect(() => insertManyViaJsonEach(widgets, [])).toThrow(/non-empty/);
  });

  it("throws on a key that isn't one of the table's columns, rather than silently dropping it", () => {
    expect(() =>
      insertManyViaJsonEach(widgets, [
        { id: "a", label: "A", ownerId: null, createdAt: now, bogus: 1 } as never,
      ]),
    ).toThrow(/not a column/);
  });
});

// Three guards added after the security review of PR #856. None is reachable
// from today's two call sites; all three are for the helper's second caller,
// since it lives in @shared/db-utils rather than being scoped to one package.
// Each would otherwise write WRONG DATA rather than fail, which is the worst
// failure mode available to an insert helper.
describe("insertManyViaJsonEach guards", () => {
  it("throws when a row omits a key the first row has", () => {
    expect(() =>
      insertManyViaJsonEach(guardTable, [
        { id: "a", label: "one", count: 1 },
        { id: "b", label: "two" },
      ] as never),
    ).toThrow(/different key set from row 0/);
  });

  it("throws when a row carries a key the first row does not", () => {
    expect(() =>
      insertManyViaJsonEach(guardTable, [
        { id: "a", label: "one" },
        { id: "b", label: "two", count: 2 },
      ] as never),
    ).toThrow(/different key set from row 0/);
  });

  it("throws when a row swaps one key for another, same count", () => {
    expect(() =>
      insertManyViaJsonEach(guardTable, [
        { id: "a", label: "one" },
        { id: "b", count: 2 },
      ] as never),
    ).toThrow(/different key set from row 0/);
  });

  // JSON numbers are IEEE-754 doubles: 2^53 + 1 comes back as 2^53.
  it("throws on an integer outside the safe range rather than truncating it", () => {
    expect(() =>
      insertManyViaJsonEach(guardTable, [
        { id: "a", label: "one", count: Number.MAX_SAFE_INTEGER + 2 },
      ] as never),
    ).toThrow(/outside ±2\^53/);
  });

  it("accepts an integer at the edge of the safe range", () => {
    expect(() =>
      insertManyViaJsonEach(guardTable, [
        { id: "a", label: "one", count: Number.MAX_SAFE_INTEGER },
      ] as never),
    ).not.toThrow();
  });
});
