import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { EffectDbService, effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { currentEventsAsParsed } from "../../src/services/changes";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { planningExportService } from "../../src/services/planning-export";
import { retentionService } from "../../src/services/retention";
import { seatingLoss, seatingService } from "../../src/services/seating";
import { seatingExportService } from "../../src/services/seating-export";

// No index on the seating tables leads with `wedding_id`, and none on the seats
// leads with `guest_id`. Every statement the seating code runs must still reach
// them by an index — a plan by its id or its event, a table by its id, its plan
// or its event, a seat by its table, its plan or its event — or each one reads
// every tenant's rows. These run every seating read and write, and every
// statement the import and the retention sweep add for seats, and check
// SQLite's plan for each: no full scan of any of the three.

interface Captured {
  sql: string;
  params: unknown[];
}

/** Every statement the client runs from here on, with the values bound to it. */
function capture(db: TestDb): Captured[] {
  const client = db.$client;
  const prepare = client.prepare.bind(client);
  const seen: Captured[] = [];
  Object.defineProperty(client, "query", {
    configurable: true,
    value: (sql: string) => {
      const statement = prepare(sql);
      for (const method of ["all", "values", "run", "get"] as const) {
        const original = statement[method].bind(statement) as (...p: unknown[]) => unknown;
        Object.defineProperty(statement, method, {
          configurable: true,
          value: (...params: unknown[]) => {
            seen.push({ sql, params });
            return original(...params);
          },
        });
      }
      return statement;
    },
  });
  return seen;
}

/** The plan lines that read a seating table (or an alias of one) in full. */
function seatingScans(db: TestDb, statements: readonly Captured[]): string[] {
  const scans: string[] = [];
  for (const { sql, params } of statements) {
    if (!/seating_/.test(sql)) continue;
    // `prepare`, not `query`: `capture` shadows `query`, and a plan read
    // through it would be captured into the list this loop is reading.
    const plan = db.$client
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as never[])) as Array<{ detail: string }>;
    for (const { detail } of plan) {
      // The seating tables and every alias the seating code gives them.
      if (/^SCAN (seating_|seat_|plan_|copy_)/.test(detail)) {
        scans.push(`${detail}  ←  ${sql.slice(0, 80)}`);
      }
    }
  }
  return scans;
}

const W = BOOTSTRAP_WEDDING_ID;
const RECEPTION = "9f7a2c14-1b3d-4e5f-8a01-000000000004";

function seeded(): TestDb {
  const db = createDb(":memory:");
  // No ANALYZE: without statistics the planner costs indexes by their shape,
  // the same as a D1 database nobody has analysed.
  seedDb(db);
  return db;
}

const run = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService | EffectDbService>) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(DbService, db),
      Effect.provideService(EffectDbService, effectDbFor(localD1Binding(db.$client), "fetch")),
    ),
  );

describe("seating statements reach their rows by an index", () => {
  it("for every chart read and write", async () => {
    const db = seeded();
    const [ada, bo] = ["Ada", "Bo"].map(
      (name) =>
        db.select({ id: guests.id }).from(guests).where(eq(guests.firstName, name)).get()!.id,
    );
    const seen = capture(db);
    const made = await run(
      db,
      seatingService.createPlan({ weddingId: W, eventId: RECEPTION, name: "Plan 1" }),
    );
    if (!Exit.isSuccess(made)) throw new Error("plan not created");
    const plan = made.value.id;
    const one = await run(
      db,
      seatingService.createTable({ weddingId: W, planId: plan, name: "T1", capacity: 1 }),
    );
    const two = await run(
      db,
      seatingService.createTable({ weddingId: W, planId: plan, name: "T2", capacity: 8 }),
    );
    if (!Exit.isSuccess(one) || !Exit.isSuccess(two)) throw new Error("tables not created");
    const t1 = one.value.id;
    const t2 = two.value.id;
    await run(db, seatingService.seat({ weddingId: W, planId: plan, guestId: ada!, tableId: t1 }));
    await run(db, seatingService.seat({ weddingId: W, planId: plan, guestId: bo!, tableId: t2 }));
    // A refusal, so the diagnosis reads run too.
    expect(
      Exit.isFailure(
        await run(
          db,
          seatingService.seat({ weddingId: W, planId: plan, guestId: bo!, tableId: t1 }),
        ),
      ),
    ).toBe(true);
    await run(db, seatingService.updateTable({ weddingId: W, tableId: t2, capacity: 4 }));
    expect(
      Exit.isFailure(
        await run(db, seatingService.updateTable({ weddingId: W, tableId: t1, capacity: 0 })),
      ),
    ).toBe(true);
    await run(db, seatingService.reorderTables(W, plan, [t2, t1]));
    await run(db, seatingService.chart(W, RECEPTION));
    // A copy, a rename, a switch of the selected plan, a refused delete, a
    // read of the copy by id, and the copy's delete once unused again.
    const copied = await run(
      db,
      seatingService.createPlan({ weddingId: W, eventId: RECEPTION, name: "Copy", copyFrom: plan }),
    );
    if (!Exit.isSuccess(copied)) throw new Error("plan not copied");
    const copy = copied.value.id;
    await run(db, seatingService.renamePlan({ weddingId: W, planId: copy, name: "Garden" }));
    await run(db, seatingService.selectPlan({ weddingId: W, eventId: RECEPTION, planId: copy }));
    expect(Exit.isFailure(await run(db, seatingService.removePlan(W, copy)))).toBe(true);
    await run(db, seatingService.chart(W, RECEPTION, plan));
    await run(db, seatingService.selectPlan({ weddingId: W, eventId: RECEPTION, planId: plan }));
    await run(db, seatingService.removePlan(W, copy));
    // A refused plan write reads to say why.
    expect(
      Exit.isFailure(
        await run(
          db,
          seatingService.createPlan({
            weddingId: W,
            eventId: RECEPTION,
            name: "Copy",
            copyFrom: "spl_nope",
          }),
        ),
      ),
    ).toBe(true);
    await run(db, seatingService.seat({ weddingId: W, planId: plan, guestId: bo!, tableId: null }));
    // The event's own addresses, which act on its plan in use.
    await run(
      db,
      seatingService.createTableAtEvent({
        weddingId: W,
        eventId: RECEPTION,
        name: "T3",
        capacity: 8,
      }),
    );
    await run(
      db,
      seatingService.seatAtEvent({ weddingId: W, eventId: RECEPTION, guestId: bo!, tableId: t2 }),
    );
    await run(db, seatingService.reorderTablesAtEvent(W, RECEPTION, [t1, t2]));
    await run(db, seatingExportService.seatingCsv(W));
    await run(db, planningExportService.moduleRows(W));
    await run(
      db,
      seatingLoss(W, {
        guestIds: [ada!],
        eventIds: [RECEPTION],
        links: [{ guestId: ada!, eventId: RECEPTION }],
      }),
    );
    await run(db, seatingService.removeTable(W, t2));

    expect(seen.filter((s) => /seating_/.test(s.sql)).length).toBeGreaterThan(15);
    expect(seatingScans(db, seen)).toEqual([]);
  });

  it("for the seats an import's event removal and the retention sweep delete", async () => {
    const db = seeded();
    const ada = db
      .select({ id: guests.id })
      .from(guests)
      .where(eq(guests.firstName, "Ada"))
      .get()!.id;
    const made = await run(
      db,
      seatingService.createPlan({ weddingId: W, eventId: RECEPTION, name: "Plan 1" }),
    );
    if (!Exit.isSuccess(made)) throw new Error("plan not created");
    const created = await run(
      db,
      seatingService.createTable({ weddingId: W, planId: made.value.id, name: "T1", capacity: 8 }),
    );
    if (!Exit.isSuccess(created)) throw new Error("table not created");
    await run(
      db,
      seatingService.seat({
        weddingId: W,
        planId: made.value.id,
        guestId: ada,
        tableId: created.value.id,
      }),
    );

    const current = await Effect.runPromise(
      currentEventsAsParsed(W).pipe(Effect.provideService(DbService, db)),
    );
    const seen = capture(db);
    const plan = await run(
      db,
      diffAgainstDb(
        current.filter((e) => e.id !== RECEPTION),
        [],
        W,
        { scope: "events" },
      ),
    );
    if (!Exit.isSuccess(plan)) throw new Error("no plan");
    await run(db, applyImport("imp-plan", plan.value, W));
    // Far past every seeded event, so the seeded wedding is swept.
    await run(db, retentionService.sweepExpiredGuestData(new Date("2030-01-01T00:00:00Z")));

    expect(
      seen.filter((s) => s.sql.startsWith('delete from "seating_')).length,
    ).toBeGreaterThanOrEqual(4);
    expect(seatingScans(db, seen)).toEqual([]);
  });
});
