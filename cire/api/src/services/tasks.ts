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
import {
  events,
  taskAssignees,
  taskTemplateDismissals,
  tasks,
  weddingHosts,
  weddings,
} from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { and, asc, eq, exists, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { bound, commitBatchResults, commitGroupedBatchResults, DbService, dbQuery } from "../db";
import type { Db } from "../db";
import type { TimeframeBucket } from "../lib/checklist-buckets";
import { stampEventOffset } from "../lib/event-time";
import { clockOffsetMinutes, deriveRunTime, isRunOffsetInRange } from "../lib/run-time";
import type { DerivedRunTime, EventTime } from "../lib/run-time";
import { metricTaskAssignmentChanged, metricTaskRunTimeChanged } from "../metrics";
import type {
  TaskAssignmentAction,
  TaskAssignmentResult,
  TaskRunTimeKind,
  TaskRunTimeResult,
} from "../metrics";
import type { RunTimePatch } from "../schemas/tasks";

/** No task with this id under this wedding (missing or another wedding's). 404-class. */
export class TaskNotInWedding extends Data.TaggedError("TaskNotInWedding") {}

/** The seat named for a task is not one of the task's wedding: another
 *  wedding's seat, a guest's id, or no seat at all. 422-class. */
export class HostNotInWedding extends Data.TaggedError("HostNotInWedding") {}

/** The event a run time links to is not one of the task's wedding: another
 *  wedding's event, any other id, or nothing. 422-class. */
export class EventNotInWedding extends Data.TaggedError("EventNotInWedding") {}

/** A clock time typed against an event is more than a day from its start, or
 *  the event's start cannot be read. 422-class. */
export class RunTimeOutOfRange extends Data.TaggedError("RunTimeOutOfRange") {}

export type TaskStatus = "open" | "done";

/** Where a task's due date comes from: `template` follows the wedding date,
 *  `manual` is whatever the couple set. */
export type TaskDueSource = "manual" | "template";

export interface TaskDto extends DerivedRunTime {
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
  /** The seats (`wedding_hosts.id`) holding the task, in the order they were
   *  added; empty for a task nobody holds. */
  assigneeHostIds: string[];
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
  /** The task's whole run time; `null` makes it untimed. */
  runTime?: RunTimePatch | null;
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
  runAt: string | null;
  runTimezone: string | null;
  eventId: string | null;
  runOffsetMinutes: number | null;
  eventRemovedAt: Date | null;
}

/** A wedding's events by id, as a linked task's time is counted from them. */
export type EventTimes = ReadonlyMap<string, EventTime>;

/** No events: for a task known to be linked to none. */
const NO_EVENTS: EventTimes = new Map();

/** A task row, the seats holding it in the order they were added, and its
 *  time, derived from `eventTimes` — which must hold only the task's own
 *  wedding's events — when it is linked to one. */
export const toDto = (r: TaskRow, assigneeHostIds: string[], eventTimes: EventTimes): TaskDto => ({
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
  ...deriveRunTime(r, eventTimes),
  assigneeHostIds,
});

/** One event's time, as {@link weddingEventTimes} and {@link taskEventTime}
 *  read it. */
interface EventTimeRow {
  id: string;
  startAt: string;
  timezone: string;
}

/** Every event of `weddingId`, as a linked task's time is counted from them.
 *  Returned unrun, so it rides in the batch that reads the tasks. */
export const weddingEventTimes = (db: Db, weddingId: string) =>
  db
    .select({ id: events.id, startAt: events.startAt, timezone: events.timezone })
    .from(events)
    .where(eq(events.weddingId, weddingId));

/** The event one task of `weddingId` is linked to, if it is that wedding's.
 *  Returned unrun, to ride after the batch's write: the link it reads is the
 *  one the write left. */
export const taskEventTime = (db: Db, weddingId: string, taskId: string) =>
  db
    .select({ id: events.id, startAt: events.startAt, timezone: events.timezone })
    .from(events)
    .where(
      and(
        eq(events.weddingId, weddingId),
        eq(
          events.id,
          sql`(SELECT ${tasks.eventId} FROM ${tasks} WHERE ${tasks.id} = ${taskId} AND ${tasks.weddingId} = ${weddingId})`,
        ),
      ),
    );

/** {@link weddingEventTimes} or {@link taskEventTime} rows, by event id. */
export const eventTimesOf = (rows: unknown): EventTimes =>
  new Map(
    (rows as readonly EventTimeRow[]).map((row) => [
      row.id,
      { startAt: row.startAt, timezone: row.timezone },
    ]),
  );

/** One (task, seat) row of `task_assignees`. */
export interface AssigneeRow {
  taskId: string;
  hostId: string;
}

/** Holders in the order they were added. `assigned_at` is in seconds, so
 *  rowid orders two seats added in the same second. */
const ASSIGNMENT_ORDER = [asc(taskAssignees.assignedAt), asc(sql`rowid`)];

/** Every holder of every task of `weddingId`, task by task, each task's in the
 *  order they were added — the order of `task_assignees_wedding_task_idx`, so
 *  the read needs no sort. Returned unrun, so it rides in the batch that reads
 *  the tasks. */
export const weddingAssignees = (db: Db, weddingId: string) =>
  db
    .select({ taskId: taskAssignees.taskId, hostId: taskAssignees.hostId })
    .from(taskAssignees)
    .where(eq(taskAssignees.weddingId, weddingId))
    .orderBy(asc(taskAssignees.taskId), ...ASSIGNMENT_ORDER);

/** The holders of one task of `weddingId`, in the order they were added.
 *  Returned unrun, for the batch that writes or reads the task. */
export const taskAssigneeIds = (db: Db, weddingId: string, taskId: string) =>
  db
    .select({ hostId: taskAssignees.hostId })
    .from(taskAssignees)
    .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.weddingId, weddingId)))
    .orderBy(...ASSIGNMENT_ORDER);

const hostIdsOf = (rows: unknown): string[] =>
  (rows as readonly { hostId: string }[]).map((row) => row.hostId);

/** A wedding's task rows as DTOs, each with its holders from `assigned`
 *  ({@link weddingAssignees}) and its time from `eventTimes`
 *  ({@link weddingEventTimes}), both read in the same batch. */
export function withAssignees(
  rows: readonly TaskRow[],
  assigned: readonly AssigneeRow[],
  eventTimes: EventTimes,
): TaskDto[] {
  const byTask = new Map<string, string[]>();
  for (const { taskId, hostId } of assigned) {
    const held = byTask.get(taskId);
    if (held) held.push(hostId);
    else byTask.set(taskId, [hostId]);
  }
  return rows.map((row) => toDto(row, byTask.get(row.id) ?? [], eventTimes));
}

/**
 * One batch for a holder write: `write`, then the task, its holders and its
 * event as they stand after it. `task` is undefined when `taskId` is not
 * `weddingId`'s; `changed` says whether `write` touched a row.
 */
function writeAssignee(
  db: Db,
  weddingId: string,
  taskId: string,
  write: BatchItem<"sqlite">,
): Effect.Effect<{
  task: TaskRow | undefined;
  holders: string[];
  eventTimes: EventTimes;
  changed: boolean;
}> {
  return Effect.map(
    dbQuery(() =>
      commitBatchResults(db, [
        write,
        db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId))),
        taskAssigneeIds(db, weddingId, taskId),
        taskEventTime(db, weddingId, taskId),
      ]),
    ),
    (results) => ({
      task: (results[1] as readonly TaskRow[])[0],
      holders: hostIdsOf(results[2]),
      eventTimes: eventTimesOf(results[3]),
      changed: (results[0] as readonly unknown[]).length > 0,
    }),
  );
}

/** Count one run-time write's outcome. */
const countRunTime = (kind: TaskRunTimeKind, result: TaskRunTimeResult) =>
  Effect.sync(() => metricTaskRunTimeChanged(kind, result));

/** The run-time columns a write sets, all five every time, so no write leaves
 *  a state the readers do not know. `eventId` and `offsetMinutes` for a link;
 *  a stamped instant and its zone for a fixed time; nothing for untimed. Any
 *  write clears the event-removed mark: the organiser has given the task a
 *  time, or none, on purpose. */
function runTimeColumns(
  value:
    | { kind: "untimed" }
    | { kind: "fixed"; at: string; timezone: string }
    | { kind: "linked"; eventId: string; offsetMinutes: number },
): SQLiteUpdateSetSource<typeof tasks> {
  const none = {
    runAt: null,
    runTimezone: null,
    eventId: null,
    runOffsetMinutes: null,
    eventRemovedAt: null,
  };
  switch (value.kind) {
    case "untimed":
      return none;
    case "fixed":
      return {
        ...none,
        runAt: stampEventOffset(value.at, value.timezone),
        runTimezone: value.timezone,
      };
    case "linked":
      return { ...none, eventId: value.eventId, runOffsetMinutes: value.offsetMinutes };
  }
}

/** Count one holder write's outcome. */
const countAssignment = (action: TaskAssignmentAction, result: TaskAssignmentResult) =>
  Effect.sync(() => metricTaskAssignmentChanged(action, result));

/** A holder write the database failed: counted and logged, then left to the
 *  route's 500. */
const onAssignmentDefect = (action: TaskAssignmentAction, weddingId: string) =>
  Effect.tapDefect(() =>
    countAssignment(action, "error").pipe(
      Effect.andThen(Effect.logError("checklist holder write failed")),
      Effect.annotateLogs({ weddingId, action }),
    ),
  );

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
 * save can commit it in the same batch as the date it reads; it answers the id
 * of each task it re-dated.
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
    )
    .returning({ id: tasks.id });
};

/** A holder write's answer: the task as it stands after it, and whether the
 *  write put a seat on or took one off (false when it was already so). */
export interface HolderWrite {
  task: TaskDto;
  changed: boolean;
}

export const tasksService = {
  list(weddingId: string): Effect.Effect<TaskDto[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // One batch: the tasks, every holder of them and the wedding's events,
      // so a checklist of any length costs three statements.
      const [rows, assigned, times] = yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .select()
            .from(tasks)
            .where(eq(tasks.weddingId, weddingId))
            .orderBy(asc(tasks.timeframeBucket), asc(tasks.sortOrder)),
          weddingAssignees(db, weddingId),
          weddingEventTimes(db, weddingId),
        ]),
      );
      return withAssignees(rows as TaskRow[], assigned as AssigneeRow[], eventTimesOf(times));
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
        runAt: null,
        runTimezone: null,
        eventId: null,
        runOffsetMinutes: null,
        eventRemovedAt: null,
      };
      yield* dbQuery(() => db.insert(tasks).values(row).run());
      // A task with a fresh id has no holders to read, and no time.
      return toDto(row, [], NO_EVENTS);
    }).pipe(Effect.withSpan("cire.tasks.create"));
  },

  /**
   * Patch a task. Every SET reads the row as it was before the UPDATE.
   *
   * `runTime` replaces the task's whole run time (see `RunTimePatch`). A link
   * is written only when the event is the task's own wedding's: the UPDATE's
   * WHERE says so, so a link to anything else writes no field of the patch at
   * all, and a probe of the task in the same batch tells `TaskNotInWedding`
   * (404, which wins) from `EventNotInWedding` (422). A clock time against an
   * event reads the event first, to count the offset from its start; one more
   * than a day away is `RunTimeOutOfRange`, with nothing written.
   */
  update(input: {
    weddingId: string;
    taskId: string;
    patch: UpdateTaskPatch;
  }): Effect.Effect<TaskDto, TaskNotInWedding | EventNotInWedding | RunTimeOutOfRange, DbService> {
    const { weddingId, taskId, patch } = input;
    const runTime = patch.runTime;
    const write = Effect.gen(function* () {
      const db = yield* DbService;
      const ours = and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId));

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

      // The event a link names, which must be this wedding's.
      let linkTo: string | null = null;
      if (runTime === null) Object.assign(set, runTimeColumns({ kind: "untimed" }));
      else if (runTime?.kind === "fixed") {
        Object.assign(
          set,
          runTimeColumns({ kind: "fixed", at: runTime.at, timezone: runTime.timezone }),
        );
      } else if (runTime !== undefined) {
        linkTo = runTime.eventId;
        let offsetMinutes: number;
        if (runTime.kind === "offset") offsetMinutes = runTime.offsetMinutes;
        else {
          // A clock time is counted from the event's start, so the event is
          // read first — with the task, so a missing task is still a 404.
          const [found, probe] = yield* dbQuery(() =>
            commitBatchResults(db, [
              db
                .select({ startAt: events.startAt, timezone: events.timezone })
                .from(events)
                .where(and(eq(events.id, runTime.eventId), eq(events.weddingId, weddingId))),
              db.select({ id: tasks.id }).from(tasks).where(ours),
            ]),
          );
          if ((probe as readonly unknown[]).length === 0) {
            return yield* Effect.fail(new TaskNotInWedding());
          }
          const event = (found as readonly EventTime[])[0];
          if (!event) return yield* Effect.fail(new EventNotInWedding());
          const counted = clockOffsetMinutes(event.startAt, event.timezone, runTime.at);
          if (counted === null || !isRunOffsetInRange(counted)) {
            return yield* Effect.fail(new RunTimeOutOfRange());
          }
          offsetMinutes = counted;
        }
        Object.assign(set, runTimeColumns({ kind: "linked", eventId: linkTo, offsetMinutes }));
      }

      // A link is written only to an event of this same wedding: bound, not
      // correlated to the task row, since the statement is scoped already.
      const where =
        linkTo === null
          ? ours
          : and(
              ours,
              exists(
                db
                  .select({ one: sql`1` })
                  .from(events)
                  .where(and(eq(events.id, linkTo), eq(events.weddingId, weddingId))),
              ),
            );

      // One batch: the UPDATE, whose RETURNING reports whether it wrote the
      // row — zero rows maps to TaskNotInWedding with no separate existence
      // SELECT, unless the patch links an event, when the probe at the end
      // tells the two refusals apart — then the task's holders and its event
      // as they stand after it. An empty patch degrades to a plain read
      // (drizzle rejects an empty SET).
      const statements: BatchItem<"sqlite">[] = [
        Object.keys(set).length === 0
          ? db.select().from(tasks).where(ours)
          : db.update(tasks).set(set).where(where).returning(),
        taskAssigneeIds(db, weddingId, taskId),
        taskEventTime(db, weddingId, taskId),
      ];
      if (linkTo !== null) statements.push(db.select({ id: tasks.id }).from(tasks).where(ours));
      const results = yield* dbQuery(() => commitBatchResults(db, statements));
      const [updated] = results[0] as readonly TaskRow[];
      if (!updated) {
        const taskThere = linkTo !== null && (results[3] as readonly unknown[]).length > 0;
        return yield* Effect.fail(taskThere ? new EventNotInWedding() : new TaskNotInWedding());
      }
      return toDto(updated, hostIdsOf(results[1]), eventTimesOf(results[2]));
    });

    if (runTime === undefined) return write.pipe(Effect.withSpan("cire.tasks.update"));
    // A patch naming the run time is counted, whatever else it names.
    const kind: TaskRunTimeKind = runTime === null ? "clear" : runTime.kind;
    return write.pipe(
      Effect.tap(() => countRunTime(kind, "ok")),
      Effect.tapError((e) =>
        countRunTime(
          kind,
          e._tag === "EventNotInWedding"
            ? "event_not_in_wedding"
            : e._tag === "RunTimeOutOfRange"
              ? "out_of_range"
              : "task_not_found",
        ),
      ),
      Effect.tapDefect(() =>
        countRunTime(kind, "error").pipe(
          Effect.andThen(Effect.logError("checklist run-time write failed")),
          Effect.annotateLogs({ weddingId, kind }),
        ),
      ),
      Effect.withSpan("cire.tasks.update"),
    );
  },

  /**
   * Put a seat of the task's wedding (`wedding_hosts.id`) on a task. Any seat
   * may hold a task, whatever its role, and a seat already on it keeps its
   * place.
   *
   * One batch: the INSERT, guarded in its own WHERE by the task and the seat
   * both being `weddingId`'s, then the task and its holders as they stand
   * after it. No task is `TaskNotInWedding`. When nothing was inserted, the
   * holders tell the two other answers apart: a seat among them was already
   * there and is answered as it is; a seat not among them is not one of the
   * wedding's — the foreign keys make every holder of a task a seat of its
   * wedding — and is `HostNotInWedding`.
   */
  addAssignee(
    weddingId: string,
    taskId: string,
    hostId: string,
  ): Effect.Effect<HolderWrite, TaskNotInWedding | HostNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const insert = db
        .insert(taskAssignees)
        .select(
          // Every `task_assignees` column, in the table's order. The task row
          // supplies its own id and wedding, so the row can only ever name the
          // task's own wedding.
          db
            .select({
              taskId: tasks.id,
              hostId: bound(hostId, taskAssignees.hostId),
              weddingId: tasks.weddingId,
              assignedAt: bound(new Date(), taskAssignees.assignedAt),
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.id, taskId),
                eq(tasks.weddingId, weddingId),
                // Bound, not correlated to the task row: the statement is
                // already scoped to the wedding, so the seat must be that
                // same wedding's.
                exists(
                  db
                    .select({ one: sql`1` })
                    .from(weddingHosts)
                    .where(and(eq(weddingHosts.id, hostId), eq(weddingHosts.weddingId, weddingId))),
                ),
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({ hostId: taskAssignees.hostId });
      const { task, holders, eventTimes, changed } = yield* writeAssignee(
        db,
        weddingId,
        taskId,
        insert,
      );
      if (!task) {
        yield* countAssignment("add", "task_not_found");
        return yield* Effect.fail(new TaskNotInWedding());
      }
      if (!changed && !holders.includes(hostId)) {
        yield* countAssignment("add", "assignee_not_in_wedding");
        return yield* Effect.fail(new HostNotInWedding());
      }
      yield* countAssignment("add", changed ? "ok" : "unchanged");
      return { task: toDto(task, holders, eventTimes), changed };
    }).pipe(onAssignmentDefect("add", weddingId), Effect.withSpan("cire.tasks.assign"));
  },

  /**
   * Take a seat off a task. A seat the task does not hold — whether or not it
   * is one of the wedding's — leaves the task as it is and is answered with
   * it. One batch: the DELETE, scoped to the wedding, then the task and its
   * holders after it. No task is `TaskNotInWedding`.
   */
  removeAssignee(
    weddingId: string,
    taskId: string,
    hostId: string,
  ): Effect.Effect<HolderWrite, TaskNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const del = db
        .delete(taskAssignees)
        .where(
          and(
            eq(taskAssignees.taskId, taskId),
            eq(taskAssignees.hostId, hostId),
            eq(taskAssignees.weddingId, weddingId),
          ),
        )
        .returning({ hostId: taskAssignees.hostId });
      const { task, holders, eventTimes, changed } = yield* writeAssignee(
        db,
        weddingId,
        taskId,
        del,
      );
      if (!task) {
        yield* countAssignment("remove", "task_not_found");
        return yield* Effect.fail(new TaskNotInWedding());
      }
      yield* countAssignment("remove", changed ? "ok" : "unchanged");
      return { task: toDto(task, holders, eventTimes), changed };
    }).pipe(onAssignmentDefect("remove", weddingId), Effect.withSpan("cire.tasks.unassign"));
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

  /**
   * Give each id its array index as `sort_order`, and answer how many tasks
   * moved. A foreign or wrong-bucket id, and a task already at its index,
   * match nothing, so an order that changes nothing answers 0 and writes no
   * row.
   */
  reorder(
    weddingId: string,
    bucket: TimeframeBucket,
    orderedIds: readonly string[],
  ): Effect.Effect<number, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Each UPDATE is scoped to (wedding, bucket) and to a task not already at
      // its index. commitGroupedBatchResults, not db.transaction(): D1 has no
      // BEGIN/COMMIT — batch() is its only atomic primitive — and the body
      // allows up to 500 ids, so the write set must chunk under the
      // 50-statement batch cap. Singleton groups: each row's UPDATE is
      // independent (a re-sent reorder converges), so chunking loses nothing.
      const results = yield* dbQuery(() =>
        commitGroupedBatchResults(
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
                  ne(tasks.sortOrder, index),
                ),
              ),
          ]),
        ),
      );
      return results.reduce<number>((moved, result) => moved + rowsChanged(result), 0);
    }).pipe(Effect.withSpan("cire.tasks.reorder"));
  },
};
