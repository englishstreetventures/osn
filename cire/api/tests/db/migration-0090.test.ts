import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data proof for migration 0088, which creates `task_assignees` and copies
// 0087's single assignee onto it: one holder row for every task whose
// `assigned_host_id` names a seat of the task's own wedding. The column and its
// values stay, because the Worker before 0088 still reads them. The D1 replay
// of the same file is in d1-integration.test.ts.
//
// 0088 is a live migration, so the chain before it is the live directory: the
// baseline and everything after it, in name order, as wrangler runs them.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG_0088 = "0088_task_assignees.sql";

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

/**
 * 0088 as wrangler sends it, one statement at a time, so a statement SQLite
 * refuses throws here: `exec` over the whole file can stop at a failed
 * statement without throwing.
 */
function apply0088(db: Database): void {
  const statements = readFileSync(join(MIGRATIONS_DIR, MIG_0088), "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  for (const statement of statements) db.run(statement);
}

function databaseBefore0088(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < MIG_0088)
    .toSorted()) {
    apply(db, file);
  }
  return db;
}

/**
 * Two weddings as 0087 leaves them. On `wed_a`, `tsk_ed` is held by the
 * editor, `tsk_own` by the owner and `tsk_none` by nobody; `tsk_stray` names
 * `wed_b`'s seat, which 0087's single-column key allowed although no API path
 * wrote it. On `wed_b`, `tsk_b` is held by its owner.
 */
function seeded(): Database {
  const db = databaseBefore0088();
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES
      ('wed_a', 'a', 'A', 1, 1), ('wed_b', 'b', 'B', 1, 1);
    INSERT INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, created_at) VALUES
      ('whost_a_owner', 'wed_a', 'usr_a', 'usr_a', 'owner', 1),
      ('whost_a_ed', 'wed_a', 'usr_ed', 'usr_a', 'editor', 1),
      ('whost_b_owner', 'wed_b', 'usr_b', 'usr_b', 'owner', 1);
    INSERT INTO tasks (id, wedding_id, title, timeframe_bucket, sort_order, created_at, assigned_host_id) VALUES
      ('tsk_ed', 'wed_a', 'Book the venue', '12m', 0, 1, 'whost_a_ed'),
      ('tsk_own', 'wed_a', 'Pick the music', '6m', 0, 1, 'whost_a_owner'),
      ('tsk_none', 'wed_a', 'Send thanks', 'after', 0, 1, NULL),
      ('tsk_stray', 'wed_a', 'Order the cake', '3m', 0, 1, 'whost_b_owner'),
      ('tsk_b', 'wed_b', 'Book the venue', '12m', 0, 1, 'whost_b_owner');
  `);
  return db;
}

type Holder = { task_id: string; host_id: string; wedding_id: string; assigned_at: number };

const holders = (db: Database): Holder[] =>
  db
    .query(
      "SELECT task_id, host_id, wedding_id, assigned_at FROM task_assignees ORDER BY task_id, host_id",
    )
    .all() as Holder[];

const taskRows = (db: Database): unknown[] => db.query("SELECT * FROM tasks ORDER BY id").all();

describe("migration 0088 — a task's assignee becomes its holder", () => {
  it("copies each task's assignee onto task_assignees, stamped in seconds as it runs", () => {
    const db = seeded();
    const before = Math.floor(Date.now() / 1000);
    apply0088(db);
    const rows = holders(db);
    expect(rows.map(({ task_id, host_id, wedding_id }) => [task_id, host_id, wedding_id])).toEqual([
      ["tsk_b", "whost_b_owner", "wed_b"],
      ["tsk_ed", "whost_a_ed", "wed_a"],
      ["tsk_own", "whost_a_owner", "wed_a"],
    ]);
    for (const row of rows) {
      expect(row.assigned_at).toBeGreaterThanOrEqual(before);
      expect(row.assigned_at).toBeLessThan(before + 60);
    }
  });

  it("gives no holder to a task nobody held or one naming another wedding's seat", () => {
    const db = seeded();
    apply0088(db);
    expect(holders(db).map((row) => row.task_id)).toEqual(["tsk_b", "tsk_ed", "tsk_own"]);
  });

  it("keeps every task and seat, and the old column's values, as they were", () => {
    const db = seeded();
    const tasksBefore = taskRows(db);
    const seatsBefore = db.query("SELECT * FROM wedding_hosts ORDER BY id").all();
    apply0088(db);
    expect(taskRows(db)).toEqual(tasksBefore);
    expect(db.query("SELECT * FROM wedding_hosts ORDER BY id").all()).toEqual(seatsBefore);
  });

  it("then takes a removed seat's holder rows and clears its old assignee, keeping the task", () => {
    const db = seeded();
    apply0088(db);
    db.exec("DELETE FROM wedding_hosts WHERE id = 'whost_a_ed'");
    expect(holders(db).map((row) => row.task_id)).toEqual(["tsk_b", "tsk_own"]);
    expect(db.query("SELECT id, assigned_host_id FROM tasks WHERE id = 'tsk_ed'").get()).toEqual({
      id: "tsk_ed",
      assigned_host_id: null,
    });
  });
});
