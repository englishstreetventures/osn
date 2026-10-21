import { describe, expect, it } from "bun:test";

import { taskAssignees } from "@cire/db";
import { and, eq } from "drizzle-orm";

import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { taskAssigneeIds, weddingAssignees } from "../../src/services/tasks";

// D1 runs with no `sqlite_stat1`, so the planner costs every index by its shape
// alone: an equality on the first column of any index reads as the same ~10
// rows, and a two-column equality as fewer. Each `task_assignees` read below
// has an index whose leading columns are exactly its equalities, so without
// statistics the planner picks that one rather than walking every assignment
// of the wedding to find a task's or a seat's few.

/** The plan SQLite chooses for a Drizzle query, one detail line per step. */
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

describe("task_assignees indexes", () => {
  it("reads one task's holders through its wedding and task, already in assignment order", () => {
    const db = seeded();
    const plan = planOf(db, taskAssigneeIds(db, "wed_bootstrap", "task_1"));
    expect(plan).toContain("task_assignees_wedding_task_idx (wedding_id=? AND task_id=?)");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("reads a wedding's holders task by task, already in assignment order", () => {
    const db = seeded();
    const plan = planOf(db, weddingAssignees(db, "wed_bootstrap"));
    expect(plan).toContain("task_assignees_wedding_task_idx (wedding_id=?)");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  // A foreign key's ON DELETE CASCADE finds the child rows with an equality on
  // every column of the child key — these two reads are those probes.
  it("finds a deleted task's assignments on both columns of its foreign key", () => {
    const db = seeded();
    const probe = db
      .select({ hostId: taskAssignees.hostId })
      .from(taskAssignees)
      .where(and(eq(taskAssignees.taskId, "task_1"), eq(taskAssignees.weddingId, "wed_bootstrap")));
    expect(planOf(db, probe)).toContain(
      "task_assignees_wedding_task_idx (wedding_id=? AND task_id=?)",
    );
  });

  it("finds a removed seat's assignments on both columns of its foreign key", () => {
    const db = seeded();
    const probe = db
      .select({ taskId: taskAssignees.taskId })
      .from(taskAssignees)
      .where(
        and(eq(taskAssignees.hostId, "whost_1"), eq(taskAssignees.weddingId, "wed_bootstrap")),
      );
    expect(planOf(db, probe)).toContain(
      "task_assignees_host_wedding_idx (host_id=? AND wedding_id=?)",
    );
  });
});
