import { budgetItems, tasks } from "@cire/db";
import { count, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { TIMEFRAME_BUCKETS } from "../lib/checklist-buckets";
import { serialiseCsv } from "../lib/csv";
import { minorToDecimal } from "../lib/money";
import { SERVICE_CATEGORIES } from "../lib/service-categories";
import { budgetService, lineEstimate } from "./budget";
import type { BudgetItemDto, PaymentDto } from "./budget";
import { tasksService } from "./tasks";
import type { TaskDto } from "./tasks";

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
 * The rows come from the modules' own reads (`budgetService.get`,
 * `tasksService.list`), which are unpaged: opening the module reads them all
 * too. The ceiling bounds what this export adds on top, the serialisation.
 */
export const MAX_PLANNING_EXPORT_ROWS = 1000;

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

/** Display position and label of each known key. An unknown key sorts after
 *  every known one and prints as stored. */
const categoryRank = new Map<string, number>(SERVICE_CATEGORIES.map((c, i) => [c.key, i]));
const categoryLabel = new Map<string, string>(SERVICE_CATEGORIES.map((c) => [c.key, c.label]));
const bucketRank = new Map<string, number>(TIMEFRAME_BUCKETS.map((b, i) => [b.key, i]));
const bucketLabel = new Map<string, string>(TIMEFRAME_BUCKETS.map((b) => [b.key, b.label]));

const rankOf = (ranks: ReadonlyMap<string, number>, key: string): number =>
  ranks.get(key) ?? ranks.size;

/** Ties on position and time fall to the id, so the order never depends on the
 *  order the database happened to return rows in. */
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const iso = (ms: number | null): string => (ms === null ? "" : new Date(ms).toISOString());

/** Keep the first `MAX_PLANNING_EXPORT_ROWS` rows, and say so when that cut any. */
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
      rows: rows.length,
      exportCap: MAX_PLANNING_EXPORT_ROWS,
      truncated: true,
    }),
    Effect.as(rows.slice(0, MAX_PLANNING_EXPORT_ROWS)),
  );
}

/**
 * The couple's budget and checklist as CSV downloads, and the row counts that
 * tell the portal whether there is anything to download.
 *
 * Both modules are Gold, reads included, but these files are not: a wedding
 * keeps its rows when its tier no longer opens the module, and the couple must
 * be able to take back what they entered. The route that serves them is the
 * owner-only export group, with no tier gate.
 *
 * Every cell goes through `serialiseCsv`, which defuses a cell a spreadsheet
 * would run as a formula. Money prints as a bare decimal in the wedding's
 * currency, which has a column of its own on every row.
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
      const snapshot = yield* budgetService.get(weddingId);
      const { currency, rsvpsClosed } = snapshot;
      const money = (minor: number | null): string =>
        minor === null ? "" : minorToDecimal(minor, currency);

      const paymentsByItem = new Map<string, PaymentDto[]>();
      for (const payment of snapshot.payments) {
        const list = paymentsByItem.get(payment.budgetItemId) ?? [];
        list.push(payment);
        paymentsByItem.set(payment.budgetItemId, list);
      }

      const items = snapshot.items.toSorted(
        (a: BudgetItemDto, b: BudgetItemDto) =>
          rankOf(categoryRank, a.category) - rankOf(categoryRank, b.category) ||
          a.sortOrder - b.sortOrder ||
          a.createdAt - b.createdAt ||
          byId(a, b),
      );

      const rows: string[][] = [];
      for (const item of items) {
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
        const itemPayments = (paymentsByItem.get(item.id) ?? []).toSorted(
          (a, b) => a.createdAt - b.createdAt || byId(a, b),
        );
        for (const payment of itemPayments) {
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
      }

      return serialiseCsv(BUDGET_HEADER, yield* capRows(rows, weddingId, "budget.csv"));
    }).pipe(Effect.withSpan("cire.planning-export.budgetCsv"));
  },

  /**
   * One row per task, in the checklist's order: lead time furthest out first,
   * then the couple's order within it. The stored bucket key sorts as text in
   * a different order ("12m" before "1m" before "6m"), so the list is
   * re-sorted here rather than taken as read.
   */
  tasksCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const list = yield* tasksService.list(weddingId);
      const rows = list
        .toSorted(
          (a: TaskDto, b: TaskDto) =>
            rankOf(bucketRank, a.timeframeBucket) - rankOf(bucketRank, b.timeframeBucket) ||
            a.sortOrder - b.sortOrder ||
            a.createdAt - b.createdAt ||
            byId(a, b),
        )
        .map((task) => [
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
   * How many budget lines and tasks the wedding holds. The portal asks before
   * it offers a download from a locked module, so it offers one only when
   * there is something in it. Payments are not counted: every payment belongs
   * to a line.
   */
  rowCounts(
    weddingId: string,
  ): Effect.Effect<{ budgetLines: number; tasks: number }, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [[lines], [taskRows]] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({ n: count() })
              .from(budgetItems)
              .where(eq(budgetItems.weddingId, weddingId))
              .all(),
          ),
          dbQuery(() =>
            db.select({ n: count() }).from(tasks).where(eq(tasks.weddingId, weddingId)).all(),
          ),
        ],
        { concurrency: 2 },
      );
      return { budgetLines: lines?.n ?? 0, tasks: taskRows?.n ?? 0 };
    }).pipe(Effect.withSpan("cire.planning-export.rowCounts"));
  },
};
