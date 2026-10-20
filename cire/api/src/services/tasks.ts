/**
 * Checklist tasks (platform Phase 1, [[platform-plan]] §4.1) — per-row CRUD over
 * a wedding's freeform task list. Deliberately its OWN service, NOT routed
 * through `changes/*`: tasks sit outside the guest/schedule reconcile pipeline.
 *
 * TENANCY: the route gate (`weddingEditor()`/`weddingMember()`) proves the caller
 * may touch `weddingId`. Every write here ADDITIONALLY scopes by `wedding_id` in
 * the WHERE clause, so an editor of wedding A can never mutate wedding B's task
 * even with a leaked task id — a mismatched (weddingId, taskId) fails
 * `TaskNotInWedding` rather than touching a row.
 */
import { taskTemplateDismissals, tasks, weddings } from "@cire/db";
import { and, asc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { bound, commitBatchResults, DbService, commitGroupedBatches, dbQuery } from "../db";
import type { Db } from "../db";
import type { TimeframeBucket } from "../lib/checklist-buckets";

/** No task with this id under this wedding (missing or another wedding's). 404-class. */
export class TaskNotInWedding extends Data.TaggedError("TaskNotInWedding") {}

export type TaskStatus = "open" | "done";

/** Where a task's due date comes from: `template` follows the wedding date,
 *  `manual` is whatever the couple set. */
export type TaskDueSource = "manual" | "template";

export interface TaskDto {
  id: string;
  weddingId: string;
  title: string;
  notes: string | null;
  timeframeBucket: string;
  dueAt: string | null;
  status: TaskStatus;
  sortOrder: number;
  /** ms epoch. */
  createdAt: number;
  /** ms epoch, or null while open. */
  completedAt: number | null;
  /** The template this task was seeded from, or null for a task the couple typed. */
  templateId: string | null;
  /** The item's key inside that template, or null. */
  templateItem: string | null;
  dueSource: TaskDueSource;
}

export interface CreateTaskInput {
  weddingId: string;
  title: string;
  timeframeBucket: TimeframeBucket;
  notes: string | null;
  dueAt: string | null;
}

export interface UpdateTaskPatch {
  title?: string;
  timeframeBucket?: TimeframeBucket;
  notes?: string | null;
  dueAt?: string | null;
  status?: TaskStatus;
  sortOrder?: number;
}

export interface TaskRow {
  id: string;
  weddingId: string;
  title: string;
  notes: string | null;
  timeframeBucket: string;
  dueAt: string | null;
  status: string;
  sortOrder: number;
  createdAt: Date;
  completedAt: Date | null;
  templateId: string | null;
  templateItem: string | null;
  dueOffsetDays: number | null;
  dueSource: TaskDueSource;
}

export const toDto = (r: TaskRow): TaskDto => ({
  id: r.id,
  weddingId: r.weddingId,
  title: r.title,
  notes: r.notes,
  timeframeBucket: r.timeframeBucket,
  dueAt: r.dueAt,
  status: r.status === "done" ? "done" : "open",
  sortOrder: r.sortOrder,
  createdAt: r.createdAt.getTime(),
  completedAt: r.completedAt ? r.completedAt.getTime() : null,
  templateId: r.templateId,
  templateItem: r.templateItem,
  dueSource: r.dueSource,
});

/**
 * A seeded task's due date: the wedding's STORED date moved by `offset` days,
 * in SQLite's own date arithmetic. NULL when the wedding has no date or the
 * item no offset, so nothing is ever guessed. The wedding id is bound rather
 * than correlated to an outer row, so the subquery cannot pick up a column of
 * the statement around it.
 */
export const anchoredDueAt = (weddingId: string, offset: SQL): SQL =>
  sql`date((SELECT ${weddings.weddingDate} FROM ${weddings} WHERE ${weddings.id} = ${weddingId}), ${offset} || ' days')`;

/**
 * Re-date every open task of `weddingId` whose due date follows the wedding
 * date, from the date as stored. A done task keeps the date it was done
 * against, and a date the couple set (`due_source = 'manual'`) is never
 * touched. A task already on the right date is not written, so a save that
 * does not move the date writes no task row. Returned unrun, so the settings
 * save can commit it in the same batch as the date it reads.
 */
export const reanchorTemplateDueDates = (db: Db, weddingId: string) => {
  const anchored = anchoredDueAt(weddingId, sql`${tasks.dueOffsetDays}`);
  return db
    .update(tasks)
    .set({ dueAt: anchored })
    .where(
      and(
        eq(tasks.weddingId, weddingId),
        isNotNull(tasks.templateId),
        eq(tasks.dueSource, "template"),
        eq(tasks.status, "open"),
        sql`${tasks.dueAt} IS NOT ${anchored}`,
      ),
    );
};

export const tasksService = {
  list(weddingId: string): Effect.Effect<TaskDto[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select()
          .from(tasks)
          .where(eq(tasks.weddingId, weddingId))
          .orderBy(asc(tasks.timeframeBucket), asc(tasks.sortOrder))
          .all(),
      );
      return (rows as TaskRow[]).map(toDto);
    }).pipe(Effect.withSpan("cire.tasks.list"));
  },

  create(input: CreateTaskInput): Effect.Effect<TaskDto, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Append to the end of the bucket: next sort_order = current max + 1.
      const [agg] = yield* dbQuery(() =>
        db
          .select({ max: sql<number | null>`max(${tasks.sortOrder})` })
          .from(tasks)
          .where(
            and(
              eq(tasks.weddingId, input.weddingId),
              eq(tasks.timeframeBucket, input.timeframeBucket),
            ),
          )
          .all(),
      );
      const sortOrder = (agg?.max ?? -1) + 1;
      const id = `tsk_${crypto.randomUUID()}`;
      const now = new Date();
      const row: TaskRow = {
        id,
        weddingId: input.weddingId,
        title: input.title,
        notes: input.notes,
        timeframeBucket: input.timeframeBucket,
        dueAt: input.dueAt,
        status: "open",
        sortOrder,
        createdAt: now,
        completedAt: null,
        templateId: null,
        templateItem: null,
        dueOffsetDays: null,
        dueSource: "manual",
      };
      yield* dbQuery(() => db.insert(tasks).values(row).run());
      return toDto(row);
    }).pipe(Effect.withSpan("cire.tasks.create"));
  },

  update(input: {
    weddingId: string;
    taskId: string;
    patch: UpdateTaskPatch;
  }): Effect.Effect<TaskDto, TaskNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, taskId, patch } = input;

      // Every SET expression below reads the row as it was before this UPDATE.
      const set: SQLiteUpdateSetSource<typeof tasks> = {};
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.timeframeBucket !== undefined) set.timeframeBucket = patch.timeframeBucket;
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.dueAt !== undefined) {
        set.dueAt = patch.dueAt;
        // A date the couple sends is theirs from now on, and the wedding date
        // stops moving it — unless it is the date already there, which an edit
        // form sends back with every other change.
        set.dueSource = sql`CASE WHEN ${tasks.dueAt} IS ${patch.dueAt} THEN ${tasks.dueSource} ELSE 'manual' END`;
      }
      if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
      if (patch.status !== undefined) {
        set.status = patch.status;
        // done stamps completed_at; reopening clears it.
        set.completedAt = patch.status === "done" ? new Date() : null;
        // A done task kept its date while the wedding date moved. Reopened, a
        // date that follows the wedding date catches up with it.
        if (patch.status === "open" && patch.dueAt === undefined) {
          set.dueAt = sql`CASE WHEN ${tasks.dueSource} = 'template' AND ${tasks.status} = 'done' THEN ${anchoredDueAt(weddingId, sql`${tasks.dueOffsetDays}`)} ELSE ${tasks.dueAt} END`;
        }
      }

      // Single round trip (as hosts.setRole): RETURNING reports whether a
      // (task, wedding) row existed — zero rows maps to TaskNotInWedding with
      // no separate existence SELECT. An empty patch degrades to a plain read
      // (drizzle rejects an empty SET).
      const [updated] = yield* dbQuery(() =>
        Object.keys(set).length === 0
          ? db
              .select()
              .from(tasks)
              .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
              .all()
          : db
              .update(tasks)
              .set(set)
              .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
              .returning()
              .all(),
      );
      if (!updated) return yield* Effect.fail(new TaskNotInWedding());
      return toDto(updated as TaskRow);
    }).pipe(Effect.withSpan("cire.tasks.update"));
  },

  remove(weddingId: string, taskId: string): Effect.Effect<void, TaskNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const ours = and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId));
      // One batch, so a seeded task is never gone without the record that the
      // couple removed it: applying its template again then leaves it out
      // unless they pick it. A typed task has no template and records nothing.
      // DELETE .. RETURNING reports whether a row existed.
      const results = yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .insert(taskTemplateDismissals)
            .select(
              db
                .select({
                  weddingId: tasks.weddingId,
                  templateId: sql<string>`${tasks.templateId}`.as("template_id"),
                  templateItem: sql<string>`${tasks.templateItem}`.as("template_item"),
                  dismissedAt: bound(new Date(), taskTemplateDismissals.dismissedAt),
                })
                .from(tasks)
                .where(and(ours, isNotNull(tasks.templateId), isNotNull(tasks.templateItem))),
            )
            .onConflictDoNothing(),
          db.delete(tasks).where(ours).returning({ id: tasks.id }),
        ]),
      );
      const [removed] = results[1] as readonly { id: string }[];
      if (!removed) return yield* Effect.fail(new TaskNotInWedding());
    }).pipe(Effect.withSpan("cire.tasks.remove"));
  },

  reorder(
    weddingId: string,
    bucket: TimeframeBucket,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Each id gets its array index as sort_order, scoped to (wedding, bucket)
      // so a foreign or wrong-bucket id is a no-op UPDATE rather than a write.
      // commitGroupedBatches, not db.transaction(): D1 has no BEGIN/COMMIT —
      // batch() is its only atomic primitive — and the body allows up to 500
      // ids, so the write set must chunk under the 50-statement batch cap.
      // Singleton groups: each row's UPDATE is independent (a re-sent reorder
      // converges), so chunking loses nothing.
      yield* dbQuery(() =>
        commitGroupedBatches(
          db,
          orderedIds.map((id, index) => [
            db
              .update(tasks)
              .set({ sortOrder: index })
              .where(
                and(
                  eq(tasks.id, id),
                  eq(tasks.weddingId, weddingId),
                  eq(tasks.timeframeBucket, bucket),
                ),
              ),
          ]),
        ),
      );
    }).pipe(Effect.withSpan("cire.tasks.reorder"));
  },
};
