/**
 * The day-of run sheet: a wedding's events and the tasks of the day, in one
 * ordered list, narrowed to what the reader's scope entitles them to.
 *
 * NARROWING HAPPENS HERE, on the server, and nowhere else: a helper scoped to
 * their own tasks who received the whole day and was shown a filtered view of
 * it would have been given the whole day. For `own`:
 *  - tasks: only those the reader's seat holds (`runSheetVisibleTo`);
 *  - events: only those one of those tasks is linked to;
 *  - people: only the seats holding one of those tasks.
 * An event carries its run of show, so an `own` reader gets the items of the
 * events they are given and of no other.
 * For `full`, every listed task, every event and every holder. No count, total
 * or other collection rides alongside, so nothing about the rest of the day
 * can be read off the answer's shape.
 *
 * A task is listed when it has a time — a fixed one, or a link to an event —
 * or sits in the `day_of` bucket.
 */
import { events, taskAssignees, tasks, weddingHosts } from "@cire/db";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { Effect } from "effect";

import { commitBatchResults, DbService, dbQuery } from "../db";
import { orderRunSheet } from "../lib/run-sheet";
import type { RunSheetEventRow, RunSheetItem } from "../lib/run-sheet";
import { metricRunSheetRead } from "../metrics";
import { runSheetVisibleTo } from "../middleware/wedding-role";
import type { RunSheetScope } from "./hosts";
import { runOfShowColumn, runOfShowFrom } from "./run-of-show";
import { eventTimesOf, weddingAssignees, withAssignees } from "./tasks";
import type { AssigneeRow, TaskRow } from "./tasks";

/** A seat holding one of the reader's tasks, before its name is looked up. */
export interface RunSheetSeat {
  hostId: string;
  osnProfileId: string;
}

export interface RunSheetRead {
  scope: RunSheetScope;
  viewerHostId: string;
  items: RunSheetItem[];
  people: RunSheetSeat[];
}

export const runSheetService = {
  /**
   * One batch of four reads — the listed tasks, their holders, the events and
   * the seats — then the narrowing, the derived times and the order, in the
   * Worker. For `own` each read already keeps to the reader's tasks (the
   * tasks they hold, those tasks' holders and events, the seats holding
   * them), so a helper's read does not grow with the rest of the wedding; the
   * Worker's narrowing below still decides what is answered. The tasks are
   * read unsorted: `orderRunSheet` puts the whole day in order. A database
   * failure is logged with the wedding and the scope alone: a task's text, a
   * person and an event's address never reach a log.
   */
  read(input: {
    weddingId: string;
    scope: RunSheetScope;
    viewerHostId: string;
  }): Effect.Effect<RunSheetRead, never, DbService> {
    const { weddingId, scope, viewerHostId } = input;
    return Effect.gen(function* () {
      const db = yield* DbService;
      const own = scope === "own";
      // `own` only: the tasks the reader's seat holds, as a subquery each read
      // narrows by (`task_assignees_host_wedding_idx`).
      const held = () =>
        db
          .select({ taskId: taskAssignees.taskId })
          .from(taskAssignees)
          .where(
            and(eq(taskAssignees.hostId, viewerHostId), eq(taskAssignees.weddingId, weddingId)),
          );
      const [taskRows, assigned, eventRows, seats] = yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.weddingId, weddingId),
                or(
                  isNotNull(tasks.runAt),
                  isNotNull(tasks.eventId),
                  eq(tasks.timeframeBucket, "day_of"),
                ),
                own ? inArray(tasks.id, held()) : undefined,
              ),
            ),
          weddingAssignees(db, weddingId, own ? viewerHostId : undefined),
          db
            .select({
              id: events.id,
              name: events.name,
              startAt: events.startAt,
              endAt: events.endAt,
              timezone: events.timezone,
              venueName: events.venueName,
              address: events.address,
              sortOrder: events.sortOrder,
              runOfShow: runOfShowColumn,
            })
            .from(events)
            .where(
              and(
                eq(events.weddingId, weddingId),
                own
                  ? inArray(
                      events.id,
                      db
                        .select({ eventId: tasks.eventId })
                        .from(tasks)
                        .where(and(eq(tasks.weddingId, weddingId), inArray(tasks.id, held()))),
                    )
                  : undefined,
              ),
            ),
          db
            .select({ hostId: weddingHosts.id, osnProfileId: weddingHosts.osnProfileId })
            .from(weddingHosts)
            .where(
              and(
                eq(weddingHosts.weddingId, weddingId),
                own
                  ? inArray(
                      weddingHosts.id,
                      db
                        .select({ hostId: taskAssignees.hostId })
                        .from(taskAssignees)
                        .where(
                          and(
                            eq(taskAssignees.weddingId, weddingId),
                            inArray(taskAssignees.taskId, held()),
                          ),
                        ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(weddingHosts.createdAt), asc(weddingHosts.id)),
        ]),
      );

      // Each event's run of show arrives as one JSON column; parsed here, in
      // the organiser's order.
      const weddingEvents = (
        eventRows as Array<Omit<RunSheetEventRow, "runOfShow"> & { runOfShow: string | null }>
      ).map((row): RunSheetEventRow => ({
        id: row.id,
        name: row.name,
        startAt: row.startAt,
        endAt: row.endAt,
        timezone: row.timezone,
        venueName: row.venueName,
        address: row.address,
        sortOrder: row.sortOrder,
        runOfShow: runOfShowFrom(row.runOfShow),
      }));
      const listed = withAssignees(
        taskRows as TaskRow[],
        assigned as AssigneeRow[],
        eventTimesOf(weddingEvents),
      );
      const visible = runSheetVisibleTo(scope, viewerHostId, listed);

      // `eventId` is already null on a link to an event not of this wedding.
      const linked = new Set(visible.flatMap((task) => (task.eventId ? [task.eventId] : [])));
      const shownEvents =
        scope === "full" ? weddingEvents : weddingEvents.filter((event) => linked.has(event.id));
      const holding = new Set(visible.flatMap((task) => task.assigneeHostIds));

      return {
        scope,
        viewerHostId,
        items: orderRunSheet(shownEvents, visible),
        people: (seats as RunSheetSeat[]).filter((seat) => holding.has(seat.hostId)),
      };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricRunSheetRead(scope, "ok"))),
      Effect.tapDefect(() =>
        Effect.sync(() => metricRunSheetRead(scope, "error")).pipe(
          Effect.andThen(Effect.logError("run sheet read failed")),
          Effect.annotateLogs({ weddingId, scope }),
        ),
      ),
      Effect.withSpan("cire.run_sheet.read"),
    );
  },
};
