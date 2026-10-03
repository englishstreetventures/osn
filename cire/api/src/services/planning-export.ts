import { budgetItems, tasks, weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { TIMEFRAME_BUCKETS, TIMEFRAME_BUCKET_KEYS } from "../lib/checklist-buckets";
import { serialiseCsv } from "../lib/csv";
import { displayRank } from "../lib/display-rank";
import { minorToDecimal } from "../lib/money";
import { SERVICE_CATEGORIES } from "../lib/service-categories";
import { budgetService, lineEstimate } from "./budget";
import type { PaymentDto } from "./budget";
import { giftCountSql } from "./gift-export";

/**
 * Row ceiling on one budget or checklist export. A budget file counts its
 * payment rows as well as its lines.
 *
 * Neither module caps how many rows a wedding holds, and an export cannot page,
 * so the file is bounded instead, and a read that passes the ceiling is LOGGED
 * rather than silently cut — the same contract as `MAX_GIFT_EXPORT_ROWS` in
 * `gift-export.ts`, whose comment carries the measurement: Workers Free allows
 * 10 ms of CPU per invocation, and building a file is dominated by
 * `serialiseCsv`, at roughly 6 ms for 2,000 gift rows.
 *
 * Half that figure, because these rows can be heavier. A budget row has the
 * same fourteen cells as a gift row, and the notes on both modules run to 2,000
 * characters against a gift note's 1,000; `serialiseCsv` scans every character.
 * Measured locally, 2,000 budget rows with 2,000-character notes take about
 * twice as long to serialise as 2,000 rows with short ones, so 1,000 of the
 * worst rows cost about what the gift ceiling allows.
 *
 * The ceiling bounds the read as well as the file: each read is ordered and cut
 * in the database at one row past it (`budgetService.exportSnapshot`, the tasks
 * read below), so the Worker never receives, sorts or builds a row it will not
 * print, however large the module is.
 */
export const MAX_PLANNING_EXPORT_ROWS = 1000;

/** One past the ceiling, so a cut is seen on the row that would be dropped. */
const READ_AHEAD = MAX_PLANNING_EXPORT_ROWS + 1;

type PlanningExport = "budget.csv" | "tasks.csv";

const BUDGET_HEADER = [
  "Kind",
  "Category",
  "Item",
  "Estimate",
  "Quoted",
  "Actual",
  "Price Per Guest",
  "Guests",
  "Payment",
  "Amount",
  "Due",
  "Paid At",
  "Currency",
  "Notes",
];

const TASKS_HEADER = ["Timeframe", "Task", "Status", "Due", "Completed At", "Notes"];

/** Display labels. An unknown key prints as stored. */
const categoryLabel = new Map<string, string>(SERVICE_CATEGORIES.map((c) => [c.key, c.label]));
const bucketLabel = new Map<string, string>(TIMEFRAME_BUCKETS.map((b) => [b.key, b.label]));

const iso = (at: Date | number | null): string => (at === null ? "" : new Date(at).toISOString());

/**
 * Keep the first `MAX_PLANNING_EXPORT_ROWS` rows, and say so when that cut any.
 * No row count: the reads stop one past the ceiling, so it could only ever
 * report that.
 */
function capRows(
  rows: string[][],
  weddingId: string,
  name: PlanningExport,
): Effect.Effect<string[][]> {
  if (rows.length <= MAX_PLANNING_EXPORT_ROWS) return Effect.succeed(rows);
  return Effect.logWarning("[planning-export] export exceeds the export ceiling").pipe(
    Effect.annotateLogs({
      weddingId,
      export: name,
      exportCap: MAX_PLANNING_EXPORT_ROWS,
      truncated: true,
    }),
    Effect.as(rows.slice(0, MAX_PLANNING_EXPORT_ROWS)),
  );
}

/**
 * The couple's budget and checklist as CSV downloads, and the row counts that
 * tell the portal whether a locked module has anything to download.
 *
 * Both modules are Gold, reads included, but these files are not: a wedding
 * keeps its rows when its tier no longer opens the module, and the couple must
 * be able to take back what they entered. The route that serves them is the
 * owner-only export group, with no tier gate.
 *
 * Every cell goes through `serialiseCsv`, which puts a `'` before a cell that
 * starts with `=`, `+`, `-` or `@`, so a spreadsheet reads it as text. Money
 * prints as a bare decimal in the wedding's currency, which has a column of its
 * own on every row.
 */
export const planningExportService = {
  /**
   * One row per budget line, in the portal's order (category, then the
   * couple's order within it), each followed by its payments. A per-head
   * line's estimate is the figure the portal shows, computed by the same
   * `lineEstimate`, and Guests is the headcount it priced: the guests expected
   * while RSVPs are open, the ones confirmed once the deadline has passed.
   */
  budgetCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const snapshot = yield* budgetService.exportSnapshot(weddingId, READ_AHEAD);
      const { currency, rsvpsClosed } = snapshot;
      const money = (minor: number | null): string =>
        minor === null ? "" : minorToDecimal(minor, currency);

      // Already in line order; grouping keeps each line's payments in theirs.
      const paymentsByItem = new Map<string, PaymentDto[]>();
      for (const payment of snapshot.payments) {
        const list = paymentsByItem.get(payment.budgetItemId) ?? [];
        list.push(payment);
        paymentsByItem.set(payment.budgetItemId, list);
      }

      const rows: string[][] = [];
      for (const item of snapshot.items) {
        const category = categoryLabel.get(item.category) ?? item.category;
        const guests =
          item.headcount === null
            ? ""
            : String(rsvpsClosed ? item.headcount.confirmed : item.headcount.expected);
        rows.push([
          "Budget line",
          category,
          item.name,
          money(lineEstimate(item, rsvpsClosed)),
          money(item.quotedMinor),
          money(item.actualMinor),
          money(item.unitPriceMinor),
          guests,
          "",
          "",
          "",
          "",
          currency,
          item.notes ?? "",
        ]);
        for (const payment of paymentsByItem.get(item.id) ?? []) {
          rows.push([
            "Payment",
            category,
            item.name,
            "",
            "",
            "",
            "",
            "",
            payment.label,
            money(payment.amountMinor),
            payment.dueAt ?? "",
            iso(payment.paidAt),
            currency,
            "",
          ]);
        }
        if (rows.length > MAX_PLANNING_EXPORT_ROWS) break;
      }

      return serialiseCsv(BUDGET_HEADER, yield* capRows(rows, weddingId, "budget.csv"));
    }).pipe(Effect.withSpan("cire.planning-export.budgetCsv"));
  },

  /**
   * One row per task, in the checklist's order: lead time furthest out first,
   * then the couple's order within it. The stored bucket key sorts as text in
   * a different order ("12m" before "1m" before "6m"), so the read orders by
   * the bucket's display position instead, and stops one row past the ceiling.
   */
  tasksCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const list = yield* dbQuery(() =>
        db
          .select({
            title: tasks.title,
            notes: tasks.notes,
            timeframeBucket: tasks.timeframeBucket,
            dueAt: tasks.dueAt,
            status: tasks.status,
            completedAt: tasks.completedAt,
          })
          .from(tasks)
          .where(eq(tasks.weddingId, weddingId))
          .orderBy(
            displayRank(tasks.timeframeBucket, TIMEFRAME_BUCKET_KEYS),
            asc(tasks.sortOrder),
            asc(tasks.createdAt),
            asc(tasks.id),
          )
          .limit(READ_AHEAD)
          .all(),
      );
      const rows = list.map((task) => [
        bucketLabel.get(task.timeframeBucket) ?? task.timeframeBucket,
        task.title,
        task.status === "done" ? "Done" : "Open",
        task.dueAt ?? "",
        iso(task.completedAt),
        task.notes ?? "",
      ]);

      return serialiseCsv(TASKS_HEADER, yield* capRows(rows, weddingId, "tasks.csv"));
    }).pipe(Effect.withSpan("cire.planning-export.tasksCsv"));
  },

  /**
   * How many rows `budget.csv`, `tasks.csv` and `gifts.csv` would carry, in one
   * statement. The portal asks before it offers a download from a locked
   * Budget, Checklist or Registry card, so it offers one only when there is
   * something in it. Budget payments are not counted: every payment belongs to
   * a line.
   */
  moduleRows(
    weddingId: string,
  ): Effect.Effect<{ budgetLines: number; tasks: number; gifts: number }, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [counts] = yield* dbQuery(() =>
        db
          .select({
            budgetLines: db.$count(budgetItems, eq(budgetItems.weddingId, weddingId)),
            tasks: db.$count(tasks, eq(tasks.weddingId, weddingId)),
            gifts: giftCountSql(db, weddingId),
          })
          .from(weddings)
          .where(eq(weddings.id, weddingId))
          .all(),
      );
      return {
        budgetLines: Number(counts?.budgetLines ?? 0),
        tasks: Number(counts?.tasks ?? 0),
        gifts: Number(counts?.gifts ?? 0),
      };
    }).pipe(Effect.withSpan("cire.planning-export.moduleRows"));
  },
};
