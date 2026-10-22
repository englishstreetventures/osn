import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

// Proof for migration 20261021153838_task_run_time, which gives `tasks` its run
// time: five nullable columns and a partial index, added in place. A rebuild of
// `tasks` would drop and recreate it, and with foreign keys enforced that
// cascades into every task's holders (`task_assignees`) and loses nothing
// visible until the checklist comes back with nobody on it — so the rows
// around it are seeded first and compared after. The D1 replay of the same
// file is in d1-integration.test.ts.
//
// It is a live migration, so the chain before it is the live directory: the
// baseline and everything after it, in the order wrangler runs them.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const MIG_TASK_RUN_TIME = "20261021153838_task_run_time.sql";

/** A file as wrangler sends it, one statement at a time, so a statement
 *  SQLite refuses throws here. */
function statementsOf(file: string): readonly string[] {
  return migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function apply(db: Database, file: string): void {
  for (const statement of statementsOf(file)) db.exec(statement);
}

function databaseBeforeTaskRunTime(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const chain = listMigrations(MIGRATIONS_DIR);
  const cut = chain.indexOf(MIG_TASK_RUN_TIME);
  expect(cut).toBeGreaterThan(0);
  for (const file of chain.slice(0, cut)) apply(db, file);
  return db;
}

/** A wedding with an event, tasks (one seeded from a template), holders, and a
 *  template item the couple removed. */
function seeded(): Database {
  const db = databaseBeforeTaskRunTime();
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_a', 'a', 'A', 1, 1);
    INSERT INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, created_at) VALUES
      ('whost_owner', 'wed_a', 'usr_a', 'usr_a', 'owner', 1),
      ('whost_helper', 'wed_a', 'usr_h', 'usr_a', 'helper', 1);
    INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone) VALUES
      ('evt_ceremony', 'wed_a', 'ceremony', 'Ceremony', '2099-06-20T15:00:00+10:00', '', 'Australia/Sydney');
    INSERT INTO tasks (id, wedding_id, title, timeframe_bucket, sort_order, created_at, template_id, template_item, due_offset_days, due_source) VALUES
      ('tsk_typed', 'wed_a', 'Bring the rings', 'day_of', 0, 1, NULL, NULL, NULL, 'manual'),
      ('tsk_seeded', 'wed_a', 'Book the venue', '12m', 0, 1, 'starter', 'book-venue', -365, 'template');
    INSERT INTO task_assignees (task_id, host_id, wedding_id, assigned_at) VALUES
      ('tsk_typed', 'whost_helper', 'wed_a', 5),
      ('tsk_typed', 'whost_owner', 'wed_a', 6);
    INSERT INTO task_template_dismissals (wedding_id, template_id, template_item, dismissed_at) VALUES
      ('wed_a', 'starter', 'pick-music', 7);
  `);
  return db;
}

// `prepare`, not `query`: `query` caches the statement, and one compiled
// before the ALTERs would read the table without its new columns.
const all = (db: Database, sql: string) => db.prepare(sql).all();

describe("migration 20261021153838_task_run_time — a task's run time", () => {
  it("adds five columns and one index in place, and no statement rebuilds a table", () => {
    const statements = statementsOf(MIG_TASK_RUN_TIME);
    expect(statements).toHaveLength(6);
    expect(statements.filter((s) => s.startsWith("ALTER TABLE `tasks` ADD"))).toHaveLength(5);
    expect(statements.filter((s) => s.startsWith("CREATE INDEX `tasks_event_idx`"))).toHaveLength(
      1,
    );
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP TABLE|INSERT INTO|RENAME/i);
    }
  });

  it("keeps every task, holder and dismissal as it was, with the new columns empty", () => {
    const db = seeded();
    const tasksBefore = all(db, "SELECT * FROM tasks ORDER BY id");
    const holdersBefore = all(db, "SELECT * FROM task_assignees ORDER BY task_id, host_id");
    const dismissalsBefore = all(db, "SELECT * FROM task_template_dismissals");

    apply(db, MIG_TASK_RUN_TIME);

    const tasksAfter = all(db, "SELECT * FROM tasks ORDER BY id") as Record<string, unknown>[];
    expect(
      tasksAfter.map((row) => {
        const {
          run_at: runAt,
          run_timezone: runTimezone,
          event_id: eventId,
          run_offset_minutes: runOffsetMinutes,
          event_removed_at: eventRemovedAt,
          ...rest
        } = row;
        expect([runAt, runTimezone, eventId, runOffsetMinutes, eventRemovedAt]).toEqual([
          null,
          null,
          null,
          null,
          null,
        ]);
        return rest;
      }),
    ).toEqual(tasksBefore as Record<string, unknown>[]);
    expect(all(db, "SELECT * FROM task_assignees ORDER BY task_id, host_id")).toEqual(
      holdersBefore,
    );
    expect(all(db, "SELECT * FROM task_template_dismissals")).toEqual(dismissalsBefore);
  });

  it("keeps a task, unlinked, when the event it is linked to is deleted", () => {
    const db = seeded();
    apply(db, MIG_TASK_RUN_TIME);
    db.run(
      "UPDATE tasks SET event_id = 'evt_ceremony', run_offset_minutes = -30 WHERE id = 'tsk_typed'",
    );

    db.run("DELETE FROM events WHERE id = 'evt_ceremony'");

    expect(all(db, "SELECT id, event_id FROM tasks WHERE id = 'tsk_typed'")).toEqual([
      { id: "tsk_typed", event_id: null },
    ]);
    // Its holders stay with it.
    expect(all(db, "SELECT host_id FROM task_assignees WHERE task_id = 'tsk_typed'")).toHaveLength(
      2,
    );
  });

  it("refuses a link to an event that does not exist", () => {
    const db = seeded();
    apply(db, MIG_TASK_RUN_TIME);
    expect(() => db.run("UPDATE tasks SET event_id = 'evt_nope' WHERE id = 'tsk_typed'")).toThrow(
      /FOREIGN KEY/,
    );
  });
});
