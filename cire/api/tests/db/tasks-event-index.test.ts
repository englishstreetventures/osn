import { describe, expect, it } from "bun:test";

import { tasks } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, eq, inArray } from "drizzle-orm";

import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";

// D1 runs with no `sqlite_stat1`, so the planner costs indexes by shape alone.
// Two reads find a task by the event it is linked to: the probe an event
// delete's `ON DELETE SET NULL` runs, and a schedule change's read of the
// tasks linked to the events it removes. Without `tasks_event_idx` the probe
// walks every task of every wedding.

/** The plan SQLite chooses for a query, one detail line per step. */
function planOf(db: TestDb, query: { toSQL(): { sql: string; params: unknown[] } }): string {
  const { sql, params } = query.toSQL();
  const rows = db.$client.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join("\n");
}

function seeded(): TestDb {
  const db = createDb(":memory:");
  seedDb(db);
  return db;
}

describe("tasks_event_idx", () => {
  it("finds the tasks an event delete unlinks by the event alone", () => {
    const db = seeded();
    const probe = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.eventId, "evt_1"));
    expect(planOf(db, probe)).toContain("tasks_event_idx (event_id=?)");
  });

  // Either index bounds it: through the event it reads the linked tasks, through
  // the wedding one wedding's checklist. Never every task on the database.
  it("reads a schedule change's linked tasks through an index, never every task", () => {
    const db = seeded();
    const read = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.weddingId, "wed_bootstrap"),
          inArray(tasks.eventId, jsonEachIn(["evt_1", "evt_2"])),
        ),
      );
    const plan = planOf(db, read);
    expect(plan).toMatch(
      /SEARCH tasks USING INDEX (tasks_event_idx|tasks_wedding_bucket_sort_idx)/,
    );
    expect(plan).not.toMatch(/SCAN tasks\b/);
  });
});
