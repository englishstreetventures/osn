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
import { tasks } from "@cire/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { TimeframeBucket } from "../lib/checklist-buckets";

/** No task with this id under this wedding (missing or another wedding's). 404-class. */
export class TaskNotInWedding extends Data.TaggedError("TaskNotInWedding") {}

export type TaskStatus = "open" | "done";

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

interface TaskRow {
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
}

const toDto = (r: TaskRow): TaskDto => ({
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
});

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

      const [existing] = yield* dbQuery(() =>
        db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new TaskNotInWedding());

      const set: Partial<TaskRow> = {};
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.timeframeBucket !== undefined) set.timeframeBucket = patch.timeframeBucket;
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
      if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
      if (patch.status !== undefined) {
        set.status = patch.status;
        // done stamps completed_at; reopening clears it.
        set.completedAt = patch.status === "done" ? new Date() : null;
      }

      yield* dbQuery(() =>
        db
          .update(tasks)
          .set(set)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .run(),
      );

      const [updated] = yield* dbQuery(() =>
        db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .all(),
      );
      if (!updated) return yield* Effect.fail(new TaskNotInWedding());
      return toDto(updated as TaskRow);
    }).pipe(Effect.withSpan("cire.tasks.update"));
  },

  remove(weddingId: string, taskId: string): Effect.Effect<void, TaskNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [existing] = yield* dbQuery(() =>
        db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new TaskNotInWedding());
      yield* dbQuery(() =>
        db
          .delete(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .run(),
      );
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
      yield* dbQuery(() =>
        db.transaction((tx) => {
          orderedIds.forEach((id, index) => {
            tx.update(tasks)
              .set({ sortOrder: index })
              .where(
                and(
                  eq(tasks.id, id),
                  eq(tasks.weddingId, weddingId),
                  eq(tasks.timeframeBucket, bucket),
                ),
              )
              .run();
          });
        }),
      );
    }).pipe(Effect.withSpan("cire.tasks.reorder"));
  },
};
