/**
 * Checklist templates: preview what a template would add to a wedding's
 * checklist, and add the items the couple picked.
 *
 * A seeded task is an ordinary task carrying where it came from
 * (`template_id`, `template_item`, `due_offset_days`, `due_source`). The unique
 * index on (wedding, template, item) is what keeps a repeated or racing apply
 * from adding an item twice; a row in `task_template_dismissals` is what keeps
 * an item the couple deleted from coming back unless they pick it again.
 *
 * TENANCY: the route gate (`weddingEditor()` + Gold) proves the caller may
 * write `weddingId`; every statement here is scoped by it as well.
 */
import { taskTemplateDismissals, tasks, weddings } from "@cire/db";
import { jsonEachIn, rowsChanged } from "@shared/db-utils";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";

import { bound, commitBatchResults, DbService, dbQuery } from "../db";
import {
  addDays,
  CHECKLIST_TEMPLATES,
  type ChecklistTemplateId,
  type ChecklistTemplateItem,
} from "../lib/checklist-templates";
import { metricChecklistTemplateApplied } from "../metrics";
import {
  anchoredDueAt,
  type AssigneeRow,
  type TaskDto,
  type TaskRow,
  weddingAssignees,
  withAssignees,
} from "./tasks";

/** `new`: not on the checklist. `added`: already on it. `removed`: the couple
 *  deleted it, so it comes back only if they pick it. */
export type TemplateItemState = "new" | "added" | "removed";

export interface TemplatePreviewItem {
  key: string;
  title: string;
  timeframeBucket: string;
  /** The due date the item would get (`YYYY-MM-DD`), or null without a
   *  wedding date or for an item with no date of its own. */
  dueAt: string | null;
  state: TemplateItemState;
}

export interface TemplatePreview {
  templateId: ChecklistTemplateId;
  weddingDate: string | null;
  items: TemplatePreviewItem[];
}

/** The fields one picked item carries into the INSERT, as one JSON array
 *  element. Named so none is mistaken for a column of `json_each` itself
 *  (`key`, `value`, `id`, …). */
interface PickedRow {
  taskId: string;
  item: string;
  title: string;
  bucket: string;
  offset: number;
  /** Position among the picked items in the same bucket. */
  rank: number;
}

/** One field of the picked item the INSERT is reading. */
const picked = (field: keyof PickedRow): SQL => sql`json_extract(picked.value, ${`$.${field}`})`;

const parseKeys = (json: string | null | undefined): Set<string> =>
  new Set(json ? (JSON.parse(json) as string[]) : []);

export const taskTemplatesService = {
  preview(
    weddingId: string,
    templateId: ChecklistTemplateId,
  ): Effect.Effect<TemplatePreview, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // One statement: the wedding's date, the template's items already on
      // the checklist and the ones the couple removed. Each subquery binds the
      // wedding id rather than reading `weddings.id`: drizzle writes a column
      // in a selected `sql` field without its table, and inside a subquery
      // over `tasks` a bare `id` would be the task's.
      const [row] = yield* dbQuery(() =>
        db
          .select({
            weddingDate: weddings.weddingDate,
            added: sql<string>`(SELECT json_group_array(${tasks.templateItem}) FROM ${tasks} WHERE ${tasks.weddingId} = ${weddingId} AND ${tasks.templateId} = ${templateId})`,
            removed: sql<string>`(SELECT json_group_array(${taskTemplateDismissals.templateItem}) FROM ${taskTemplateDismissals} WHERE ${taskTemplateDismissals.weddingId} = ${weddingId} AND ${taskTemplateDismissals.templateId} = ${templateId})`,
          })
          .from(weddings)
          .where(eq(weddings.id, weddingId))
          .limit(1)
          .all(),
      );
      const weddingDate = row?.weddingDate ?? null;
      const added = parseKeys(row?.added);
      const removed = parseKeys(row?.removed);
      const items = CHECKLIST_TEMPLATES[templateId].map((item): TemplatePreviewItem => ({
        key: item.key,
        title: item.title,
        timeframeBucket: item.timeframeBucket,
        dueAt: weddingDate === null ? null : addDays(weddingDate, item.offsetDays),
        state: added.has(item.key) ? "added" : removed.has(item.key) ? "removed" : "new",
      }));
      return { templateId, weddingDate, items };
    }).pipe(Effect.withSpan("cire.tasks.template_preview"));
  },

  /**
   * Add the template items in `keys` (each one an item of the template; the
   * route has checked) that the checklist does not already hold, and return
   * the whole checklist after it.
   *
   * Picking an item the couple removed is their confirmation to bring it
   * back, so its removal record is cleared in the same batch. One batch, no
   * read before it: the unique index skips an item already there, and each
   * new task goes after the tasks already in its bucket. The checklist it
   * answers with carries every task's holders, read in the same batch.
   */
  apply(input: {
    weddingId: string;
    templateId: ChecklistTemplateId;
    keys: readonly string[];
    now?: Date;
  }): Effect.Effect<{ added: number; tasks: TaskDto[] }, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, templateId } = input;
      const now = input.now ?? new Date();
      const wanted = new Set(input.keys);
      // Template order, so a bucket's new tasks keep the order the template
      // lists them in.
      const chosen = CHECKLIST_TEMPLATES[templateId].filter((item) => wanted.has(item.key));

      const rows = pickedRows(chosen);
      const results = yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .delete(taskTemplateDismissals)
            .where(
              and(
                eq(taskTemplateDismissals.weddingId, weddingId),
                eq(taskTemplateDismissals.templateId, templateId),
                inArray(taskTemplateDismissals.templateItem, jsonEachIn(rows.map((r) => r.item))),
              ),
            ),
          db
            .insert(tasks)
            .select(
              // Every `tasks` column, in the table's order. The picked items
              // ride as ONE bound JSON array, so the statement binds the same
              // handful of parameters however many items there are.
              db
                .select({
                  id: sql<string>`${picked("taskId")}`.as("id"),
                  weddingId: bound(weddingId, tasks.weddingId),
                  title: sql<string>`${picked("title")}`.as("title"),
                  notes: sql`NULL`.as("notes"),
                  timeframeBucket: sql<string>`${picked("bucket")}`.as("timeframe_bucket"),
                  dueAt: anchoredDueAt(weddingId, picked("offset")).as("due_at"),
                  status: bound("open", tasks.status),
                  // After the bucket's existing tasks. SQLite runs the whole
                  // SELECT before inserting a row when it reads the table being
                  // inserted into, so this is the max from before the insert.
                  sortOrder:
                    sql<number>`(SELECT coalesce(max(${tasks.sortOrder}), -1) FROM ${tasks} WHERE ${tasks.weddingId} = ${weddingId} AND ${tasks.timeframeBucket} = ${picked("bucket")}) + 1 + ${picked("rank")}`.as(
                      "sort_order",
                    ),
                  createdAt: bound(now, tasks.createdAt),
                  completedAt: sql`NULL`.as("completed_at"),
                  templateId: bound(templateId, tasks.templateId),
                  templateItem: sql<string>`${picked("item")}`.as("template_item"),
                  dueOffsetDays: sql<number>`${picked("offset")}`.as("due_offset_days"),
                  dueSource: bound("template", tasks.dueSource),
                  // A seeded task starts untimed.
                  runAt: sql`NULL`.as("run_at"),
                  runTimezone: sql`NULL`.as("run_timezone"),
                  eventId: sql`NULL`.as("event_id"),
                  runOffsetMinutes: sql`NULL`.as("run_offset_minutes"),
                  eventRemovedAt: sql`NULL`.as("event_removed_at"),
                })
                .from(sql`json_each(${JSON.stringify(rows)}) AS picked`)
                // SQLite needs a WHERE before the ON CONFLICT of an
                // INSERT … SELECT, or it reads ON as a join constraint.
                .where(sql`true`),
            )
            .onConflictDoNothing(),
          db
            .select()
            .from(tasks)
            .where(eq(tasks.weddingId, weddingId))
            .orderBy(asc(tasks.timeframeBucket), asc(tasks.sortOrder)),
          // The holders of the tasks already there: the portal replaces its
          // checklist with this answer.
          weddingAssignees(db, weddingId),
        ]),
      );
      const added = rowsChanged(results[1]);
      metricChecklistTemplateApplied(templateId, added);
      return {
        added,
        tasks: withAssignees(results[2] as TaskRow[], results[3] as AssigneeRow[]),
      };
    }).pipe(Effect.withSpan("cire.tasks.template_apply"));
  },
};

function pickedRows(chosen: readonly ChecklistTemplateItem[]): PickedRow[] {
  const perBucket = new Map<string, number>();
  return chosen.map((item) => {
    const rank = perBucket.get(item.timeframeBucket) ?? 0;
    perBucket.set(item.timeframeBucket, rank + 1);
    return {
      taskId: `tsk_${crypto.randomUUID()}`,
      item: item.key,
      title: item.title,
      bucket: item.timeframeBucket,
      offset: item.offsetDays,
      rank,
    };
  });
}
