import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, budgetItems, payments, tasks, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Logger, References } from "effect";

import type { Db } from "../../src/db";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { minorToDecimal } from "../../src/lib/money";
import { budgetService, lineEstimate } from "../../src/services/budget";
import {
  MAX_PLANNING_EXPORT_ROWS,
  planningExportService,
} from "../../src/services/planning-export";
import { insertWedding } from "../test-helpers/wedding";

const OTHER = "wed_other";

/** Split a CSV document into lines (CRLF, per RFC 4180). */
const lines = (csv: string) => csv.split("\r\n");

/** Fixed clock for the seeds, so ordering on time is stable. */
const at = (minutes: number) => new Date(Date.UTC(2026, 7, 20, 10, minutes, 0));

const BUDGET_HEADER =
  "Kind,Category,Item,Estimate,Quoted,Actual,Price Per Guest,Guests,Payment,Amount,Due,Paid At,Currency,Notes";
const TASKS_HEADER = "Timeframe,Task,Status,Due,Completed At,Notes";

function freshDb(): Db {
  const db = createDb(":memory:");
  seedDb(db);
  insertWedding(db, {
    id: OTHER,
    slug: "other",
    displayName: "Other",
    createdAt: at(0),
    updatedAt: at(0),
    owners: ["usr_bob"],
  });
  return db;
}

const run = <A>(db: Db, eff: Effect.Effect<A, never, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

interface ItemSeed {
  id: string;
  category: string;
  name: string;
  sortOrder: number;
  weddingId?: string;
  estimateMinor?: number | null;
  quotedMinor?: number | null;
  actualMinor?: number | null;
  unitPriceMinor?: number | null;
  notes?: string | null;
}

function insertItem(db: Db, seed: ItemSeed) {
  db.insert(budgetItems)
    .values({
      id: seed.id,
      weddingId: seed.weddingId ?? BOOTSTRAP_WEDDING_ID,
      category: seed.category,
      name: seed.name,
      estimateMinor: seed.estimateMinor ?? null,
      quotedMinor: seed.quotedMinor ?? null,
      actualMinor: seed.actualMinor ?? null,
      unitPriceMinor: seed.unitPriceMinor ?? null,
      perHeadEventIds: null,
      notes: seed.notes ?? null,
      sortOrder: seed.sortOrder,
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
}

interface PaymentSeed {
  id: string;
  itemId: string;
  label: string;
  amountMinor: number;
  createdAt: Date;
  dueAt?: string | null;
  paidAt?: Date | null;
}

function insertPayment(db: Db, seed: PaymentSeed) {
  db.insert(payments)
    .values({
      id: seed.id,
      budgetItemId: seed.itemId,
      label: seed.label,
      amountMinor: seed.amountMinor,
      dueAt: seed.dueAt ?? null,
      paidAt: seed.paidAt ?? null,
      createdAt: seed.createdAt,
    })
    .run();
}

interface TaskSeed {
  id: string;
  title: string;
  bucket: string;
  sortOrder: number;
  weddingId?: string;
  status?: "open" | "done";
  dueAt?: string | null;
  notes?: string | null;
  completedAt?: Date | null;
}

function insertTask(db: Db, seed: TaskSeed) {
  db.insert(tasks)
    .values({
      id: seed.id,
      weddingId: seed.weddingId ?? BOOTSTRAP_WEDDING_ID,
      title: seed.title,
      notes: seed.notes ?? null,
      timeframeBucket: seed.bucket,
      dueAt: seed.dueAt ?? null,
      status: seed.status ?? "open",
      sortOrder: seed.sortOrder,
      createdAt: at(0),
      completedAt: seed.completedAt ?? null,
    })
    .run();
}

/** A logger that keeps only the warnings, with the fiber's annotations. */
function captureWarnings() {
  const warnings: Array<{ message: string; annotations: Record<string, unknown> }> = [];
  const layer = Logger.layer([
    Logger.make(({ logLevel, message, fiber }) => {
      if (logLevel === "Warn") {
        warnings.push({
          message: Array.isArray(message) ? message.join(" ") : String(message),
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      }
    }),
  ]);
  return { warnings, layer };
}

describe("planningExportService.budgetCsv", () => {
  it("is the header alone for a wedding with no budget", async () => {
    const csv = await run(freshDb(), planningExportService.budgetCsv(BOOTSTRAP_WEDDING_ID));
    expect(csv).toBe(BUDGET_HEADER);
  });

  it("prints each line, then its payments, in the portal's category order", async () => {
    const db = freshDb();
    // Inserted out of display order: catering's key sorts before venue's, but
    // Venue is the first category the portal shows.
    insertItem(db, {
      id: "bit_cater",
      category: "catering",
      name: "Caterer",
      sortOrder: 0,
      estimateMinor: 900_000,
      notes: "Ask about the vegan menu",
    });
    insertItem(db, {
      id: "bit_venue_b",
      category: "venue",
      name: "Garden",
      sortOrder: 1,
      quotedMinor: 120_050,
    });
    insertItem(db, {
      id: "bit_venue_a",
      category: "venue",
      name: "Hall",
      sortOrder: 0,
      estimateMinor: 500_000,
      quotedMinor: 550_000,
      actualMinor: 549_900,
    });
    // Two payments in the same second: the id breaks the tie.
    insertPayment(db, {
      id: "pay_b",
      itemId: "bit_venue_a",
      label: "Balance",
      amountMinor: 349_900,
      createdAt: at(5),
      dueAt: "2027-02-01",
    });
    insertPayment(db, {
      id: "pay_a",
      itemId: "bit_venue_a",
      label: "Deposit",
      amountMinor: 200_000,
      createdAt: at(5),
      dueAt: "2026-11-01",
      paidAt: at(30),
    });

    const csv = await run(db, planningExportService.budgetCsv(BOOTSTRAP_WEDDING_ID));
    expect(lines(csv)).toEqual([
      BUDGET_HEADER,
      "Budget line,Venue,Hall,5000.00,5500.00,5499.00,,,,,,,AUD,",
      "Payment,Venue,Hall,,,,,,Deposit,2000.00,2026-11-01,2026-08-20T10:30:00.000Z,AUD,",
      "Payment,Venue,Hall,,,,,,Balance,3499.00,2027-02-01,,AUD,",
      "Budget line,Venue,Garden,,1200.50,,,,,,,,AUD,",
      "Budget line,Catering,Caterer,9000.00,,,,,,,,,AUD,Ask about the vegan menu",
    ]);
  });

  it("prices a per-head line exactly as the portal's budget read does", async () => {
    const db = freshDb();
    insertItem(db, {
      id: "bit_food",
      category: "catering",
      name: "Dinner",
      sortOrder: 0,
      unitPriceMinor: 8_500,
    });

    const snapshot = await run(db, budgetService.get(BOOTSTRAP_WEDDING_ID));
    const item = snapshot.items[0]!;
    const heads = snapshot.rsvpsClosed ? item.headcount!.confirmed : item.headcount!.expected;
    const estimate = lineEstimate(item, snapshot.rsvpsClosed)!;

    const csv = await run(db, planningExportService.budgetCsv(BOOTSTRAP_WEDDING_ID));
    expect(lines(csv)[1]).toBe(
      `Budget line,Catering,Dinner,${minorToDecimal(estimate, "AUD")},,,85.00,${heads},,,,,AUD,`,
    );
  });

  it("prints money in the wedding's currency, with that currency's decimals", async () => {
    const db = freshDb();
    db.update(weddings).set({ currency: "JPY" }).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID)).run();
    insertItem(db, {
      id: "bit_kimono",
      category: "attire",
      name: "Kimono",
      sortOrder: 0,
      estimateMinor: 300_000,
    });

    const csv = await run(db, planningExportService.budgetCsv(BOOTSTRAP_WEDDING_ID));
    expect(lines(csv)[1]).toBe("Budget line,Attire,Kimono,300000,,,,,,,,,JPY,");
  });

  it("defuses a cell a spreadsheet would read as a formula", async () => {
    const db = freshDb();
    insertItem(db, {
      id: "bit_evil",
      category: "other",
      name: '=HYPERLINK("http://evil.invalid")',
      sortOrder: 0,
      notes: "+1 for the band",
    });
    insertPayment(db, {
      id: "pay_evil",
      itemId: "bit_evil",
      label: "@SUM(A1)",
      amountMinor: 100,
      createdAt: at(1),
      dueAt: "-tomorrow",
    });

    const csv = await run(db, planningExportService.budgetCsv(BOOTSTRAP_WEDDING_ID));
    const [, line, payment] = lines(csv);
    expect(line).toBe(
      `Budget line,Other,"'=HYPERLINK(""http://evil.invalid"")",,,,,,,,,,AUD,'+1 for the band`,
    );
    expect(payment).toBe(
      `Payment,Other,"'=HYPERLINK(""http://evil.invalid"")",,,,,,'@SUM(A1),1.00,'-tomorrow,,AUD,`,
    );
  });

  it("prints a category it does not know by its stored key, after every known one", async () => {
    const db = freshDb();
    insertItem(db, { id: "bit_odd", category: "fireworks", name: "Sparklers", sortOrder: 0 });
    insertItem(db, { id: "bit_other", category: "other", name: "Misc", sortOrder: 0 });

    const csv = await run(db, planningExportService.budgetCsv(BOOTSTRAP_WEDDING_ID));
    expect(lines(csv).slice(1)).toEqual([
      "Budget line,Other,Misc,,,,,,,,,,AUD,",
      "Budget line,fireworks,Sparklers,,,,,,,,,,AUD,",
    ]);
  });

  it("prints only this wedding's lines and payments", async () => {
    const db = freshDb();
    insertItem(db, { id: "bit_mine", category: "cake", name: "Our cake", sortOrder: 0 });
    insertItem(db, {
      id: "bit_theirs",
      category: "cake",
      name: "Their cake",
      sortOrder: 0,
      weddingId: OTHER,
    });
    insertPayment(db, {
      id: "pay_theirs",
      itemId: "bit_theirs",
      label: "Their deposit",
      amountMinor: 100,
      createdAt: at(1),
    });

    const csv = await run(db, planningExportService.budgetCsv(BOOTSTRAP_WEDDING_ID));
    expect(csv).toContain("Our cake");
    expect(csv).not.toContain("Their cake");
    expect(csv).not.toContain("Their deposit");
  });

  it("stops at the row ceiling, counting payments, and warns that it cut", async () => {
    const db = freshDb();
    // One line with a payment, then lines enough to pass the ceiling by one.
    insertItem(db, { id: "bit_0000", category: "venue", name: "line-0000", sortOrder: 0 });
    insertPayment(db, {
      id: "pay_0000",
      itemId: "bit_0000",
      label: "Deposit",
      amountMinor: 100,
      createdAt: at(1),
    });
    const rest = Array.from({ length: MAX_PLANNING_EXPORT_ROWS - 1 }, (_, i) => i + 1);
    for (let start = 0; start < rest.length; start += 100) {
      db.insert(budgetItems)
        .values(
          rest.slice(start, start + 100).map((i) => ({
            id: `bit_${String(i).padStart(4, "0")}`,
            weddingId: BOOTSTRAP_WEDDING_ID,
            category: "other",
            name: `line-${String(i).padStart(4, "0")}`,
            sortOrder: i,
            createdAt: at(0),
            updatedAt: at(0),
          })),
        )
        .run();
    }

    const { warnings, layer } = captureWarnings();
    const csv = await Effect.runPromise(
      planningExportService
        .budgetCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
    );

    const data = lines(csv).slice(1);
    expect(data).toHaveLength(MAX_PLANNING_EXPORT_ROWS);
    expect(data[0]).toStartWith("Budget line,Venue,line-0000,");
    expect(data[1]).toStartWith("Payment,Venue,line-0000,");
    // The last line in display order is the one that did not fit.
    const lastName = `line-${String(MAX_PLANNING_EXPORT_ROWS - 1).padStart(4, "0")}`;
    expect(csv).not.toContain(lastName);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("exceeds the export ceiling");
    expect(warnings[0]!.annotations).toEqual({
      weddingId: BOOTSTRAP_WEDDING_ID,
      export: "budget.csv",
      rows: MAX_PLANNING_EXPORT_ROWS + 1,
      exportCap: MAX_PLANNING_EXPORT_ROWS,
      truncated: true,
    });
  }, 30_000);
});

describe("planningExportService.tasksCsv", () => {
  it("is the header alone for a wedding with no tasks", async () => {
    const csv = await run(freshDb(), planningExportService.tasksCsv(BOOTSTRAP_WEDDING_ID));
    expect(csv).toBe(TASKS_HEADER);
  });

  it("prints tasks by lead time, furthest out first, then in the couple's order", async () => {
    const db = freshDb();
    // Bucket keys sort as text in the wrong order ("12m" < "1m" < "6m" <
    // "day_of"); the file follows the checklist's own order instead.
    insertTask(db, { id: "tsk_day", title: "Pin the buttonholes", bucket: "day_of", sortOrder: 0 });
    insertTask(db, { id: "tsk_1m_b", title: "Final numbers", bucket: "1m", sortOrder: 1 });
    insertTask(db, {
      id: "tsk_1m_a",
      title: "Seating plan",
      bucket: "1m",
      sortOrder: 0,
      dueAt: "2027-02-14",
    });
    insertTask(db, {
      id: "tsk_12m",
      title: "Book the venue",
      bucket: "12m",
      sortOrder: 0,
      status: "done",
      completedAt: at(45),
      notes: "Deposit paid, contract signed",
    });
    insertTask(db, { id: "tsk_6m", title: "Send invites", bucket: "6m", sortOrder: 0 });

    const csv = await run(db, planningExportService.tasksCsv(BOOTSTRAP_WEDDING_ID));
    expect(lines(csv)).toEqual([
      TASKS_HEADER,
      '12+ months out,Book the venue,Done,,2026-08-20T10:45:00.000Z,"Deposit paid, contract signed"',
      "6 months out,Send invites,Open,,,",
      "1 month out,Seating plan,Open,2027-02-14,,",
      "1 month out,Final numbers,Open,,,",
      "Day of,Pin the buttonholes,Open,,,",
    ]);
  });

  it("prints a bucket it does not know by its stored key, after every known one", async () => {
    const db = freshDb();
    insertTask(db, { id: "tsk_odd", title: "Mystery", bucket: "someday", sortOrder: 0 });
    insertTask(db, { id: "tsk_day", title: "Breathe", bucket: "day_of", sortOrder: 0 });

    const csv = await run(db, planningExportService.tasksCsv(BOOTSTRAP_WEDDING_ID));
    expect(lines(csv).slice(1)).toEqual(["Day of,Breathe,Open,,,", "someday,Mystery,Open,,,"]);
  });

  it("defuses a cell a spreadsheet would read as a formula", async () => {
    const db = freshDb();
    insertTask(db, {
      id: "tsk_evil",
      title: "=cmd|' /C calc'!A0",
      bucket: "3m",
      sortOrder: 0,
      notes: "@everyone",
      dueAt: "+1",
    });

    const csv = await run(db, planningExportService.tasksCsv(BOOTSTRAP_WEDDING_ID));
    expect(lines(csv)[1]).toBe("3 months out,'=cmd|' /C calc'!A0,Open,'+1,,'@everyone");
  });

  it("prints only this wedding's tasks", async () => {
    const db = freshDb();
    insertTask(db, { id: "tsk_mine", title: "Ours", bucket: "3m", sortOrder: 0 });
    insertTask(db, {
      id: "tsk_theirs",
      title: "Theirs",
      bucket: "3m",
      sortOrder: 0,
      weddingId: OTHER,
    });

    const csv = await run(db, planningExportService.tasksCsv(BOOTSTRAP_WEDDING_ID));
    expect(csv).toContain("Ours");
    expect(csv).not.toContain("Theirs");
  });

  it("stops at the row ceiling and warns that it cut", async () => {
    const db = freshDb();
    const all = Array.from({ length: MAX_PLANNING_EXPORT_ROWS + 1 }, (_, i) => i);
    for (let start = 0; start < all.length; start += 100) {
      db.insert(tasks)
        .values(
          all.slice(start, start + 100).map((i) => ({
            id: `tsk_${String(i).padStart(4, "0")}`,
            weddingId: BOOTSTRAP_WEDDING_ID,
            title: `task-${String(i).padStart(4, "0")}`,
            timeframeBucket: "3m",
            sortOrder: i,
            createdAt: at(0),
          })),
        )
        .run();
    }

    const { warnings, layer } = captureWarnings();
    const csv = await Effect.runPromise(
      planningExportService
        .tasksCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
    );

    const data = lines(csv).slice(1);
    expect(data).toHaveLength(MAX_PLANNING_EXPORT_ROWS);
    expect(data[0]).toStartWith("3 months out,task-0000,");
    expect(csv).not.toContain(`task-${String(MAX_PLANNING_EXPORT_ROWS).padStart(4, "0")}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.annotations).toEqual({
      weddingId: BOOTSTRAP_WEDDING_ID,
      export: "tasks.csv",
      rows: MAX_PLANNING_EXPORT_ROWS + 1,
      exportCap: MAX_PLANNING_EXPORT_ROWS,
      truncated: true,
    });
  }, 30_000);

  it("prints a list exactly at the ceiling whole, and does not warn", async () => {
    const db = freshDb();
    const all = Array.from({ length: MAX_PLANNING_EXPORT_ROWS }, (_, i) => i);
    for (let start = 0; start < all.length; start += 100) {
      db.insert(tasks)
        .values(
          all.slice(start, start + 100).map((i) => ({
            id: `tsk_${String(i).padStart(4, "0")}`,
            weddingId: BOOTSTRAP_WEDDING_ID,
            title: `task-${String(i).padStart(4, "0")}`,
            timeframeBucket: "3m",
            sortOrder: i,
            createdAt: at(0),
          })),
        )
        .run();
    }

    const { warnings, layer } = captureWarnings();
    const csv = await Effect.runPromise(
      planningExportService
        .tasksCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
    );
    expect(lines(csv).slice(1)).toHaveLength(MAX_PLANNING_EXPORT_ROWS);
    expect(warnings).toEqual([]);
  }, 30_000);
});

describe("planningExportService.rowCounts", () => {
  it("counts this wedding's budget lines and tasks, and nobody else's", async () => {
    const db = freshDb();
    insertItem(db, { id: "bit_1", category: "venue", name: "Hall", sortOrder: 0 });
    insertItem(db, { id: "bit_2", category: "cake", name: "Cake", sortOrder: 0 });
    insertPayment(db, {
      id: "pay_1",
      itemId: "bit_1",
      label: "Deposit",
      amountMinor: 100,
      createdAt: at(1),
    });
    insertItem(db, {
      id: "bit_x",
      category: "venue",
      name: "Theirs",
      sortOrder: 0,
      weddingId: OTHER,
    });
    insertTask(db, { id: "tsk_1", title: "One", bucket: "3m", sortOrder: 0 });
    insertTask(db, { id: "tsk_x", title: "Theirs", bucket: "3m", sortOrder: 0, weddingId: OTHER });

    expect(await run(db, planningExportService.rowCounts(BOOTSTRAP_WEDDING_ID))).toEqual({
      budgetLines: 2,
      tasks: 1,
    });
  });

  it("is zero and zero for a wedding that never used either module", async () => {
    expect(await run(freshDb(), planningExportService.rowCounts(BOOTSTRAP_WEDDING_ID))).toEqual({
      budgetLines: 0,
      tasks: 0,
    });
  });
});
