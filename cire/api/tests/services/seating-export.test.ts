import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  seatingAssignments,
  seatingPlans,
  seatingTables,
} from "@cire/db";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Cause, Effect, Exit, Logger, References } from "effect";

import { DbService } from "../../src/db";
import { EffectDbService, effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { MAX_SEATING_EXPORT_ROWS, seatingExportService } from "../../src/services/seating-export";
import { recordStatements } from "../test-helpers";

// The venue file's ceiling: a file can hold every seated guest at every event,
// so it is bounded by the Worker's CPU rather than by any one chart, and the
// bound applies to the read, not only to what is printed.

const EVENT = "evt_big";
const PLAN = "spl_big";

/** One event, one table and `count` seated guests, named in print order. */
function seatedWedding(count: number): TestDb {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const now = new Date();
  db.insert(events)
    .values({
      id: EVENT,
      weddingId: BOOTSTRAP_WEDDING_ID,
      slug: "reception",
      name: "Reception",
      startAt: "2027-03-01T18:00",
      endAt: "",
      timezone: "UTC",
    })
    .run();
  db.insert(families)
    .values({
      id: "fam_big",
      weddingId: BOOTSTRAP_WEDDING_ID,
      publicId: "BIG-AAA-0001",
      familyName: "Big",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(seatingPlans)
    .values({
      id: PLAN,
      weddingId: BOOTSTRAP_WEDDING_ID,
      eventId: EVENT,
      name: "Plan 1",
      selected: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(seatingTables)
    .values({
      id: "stb_big",
      weddingId: BOOTSTRAP_WEDDING_ID,
      eventId: EVENT,
      planId: PLAN,
      name: "Long table",
      capacity: count,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const ids = Array.from({ length: count }, (_, i) => `g_${String(i).padStart(5, "0")}`);
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    db.insert(guests)
      .values(
        chunk.map((id, k) => ({
          id,
          familyId: "fam_big",
          firstName: id,
          sortOrder: start + k,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    db.insert(guestEvents)
      .values(chunk.map((id) => ({ guestId: id, eventId: EVENT })))
      .run();
    db.insert(seatingAssignments)
      .values(
        chunk.map((id) => ({
          tableId: "stb_big",
          planId: PLAN,
          eventId: EVENT,
          guestId: id,
          createdAt: now,
        })),
      )
      .run();
  }
  return db;
}

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

describe("seatingExportService.seatingCsv — the ceiling", () => {
  it("reads one row past the ceiling, prints the ceiling's worth, and says it cut", async () => {
    const db = seatedWedding(MAX_SEATING_EXPORT_ROWS + 50);
    const statements = recordStatements(db);
    const { warnings, layer } = captureWarnings();
    const csv = await Effect.runPromise(
      seatingExportService
        .seatingCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(
          Effect.provideService(DbService, db),
          Effect.provideService(EffectDbService, effectDbFor(localD1Binding(db.$client), "fetch")),
          Effect.provide(layer),
        ),
    );

    const read = statements.find((s) => /from "events"/.test(s.sql))!;
    expect(read.rowCounts).toEqual([MAX_SEATING_EXPORT_ROWS + 1]);
    const rows = csv.split("\r\n").slice(1);
    expect(rows).toHaveLength(MAX_SEATING_EXPORT_ROWS);
    expect(rows.at(-1)).toContain(`g_${String(MAX_SEATING_EXPORT_ROWS - 1).padStart(5, "0")}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("exceeds the export ceiling");
    expect(warnings[0]!.annotations).toMatchObject({
      weddingId: BOOTSTRAP_WEDDING_ID,
      exportCap: MAX_SEATING_EXPORT_ROWS,
    });
  }, 30_000);

  it("prints a file at the ceiling whole, and says nothing", async () => {
    const db = seatedWedding(MAX_SEATING_EXPORT_ROWS);
    const { warnings, layer } = captureWarnings();
    const csv = await Effect.runPromise(
      seatingExportService
        .seatingCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(
          Effect.provideService(DbService, db),
          Effect.provideService(EffectDbService, effectDbFor(localD1Binding(db.$client), "fetch")),
          Effect.provide(layer),
        ),
    );
    expect(csv.split("\r\n").slice(1)).toHaveLength(MAX_SEATING_EXPORT_ROWS);
    expect(warnings).toEqual([]);
  }, 30_000);
});

describe("seatingExportService.seatingCsv — a failed read", () => {
  // The read is one statement, so a rejection fails the export as a defect, which the route answers with 500.
  it("dies with the injected error rather than failing typed", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const base = localD1Binding(db.$client);
    const failing = Object.assign(Object.create(base), {
      prepare: (query: string): D1PreparedStatement => {
        const real = base.prepare(query);
        if (!query.includes('from "events"')) return real;
        const rejected: D1PreparedStatement = Object.assign(Object.create(real.bind()), {
          raw: () => Promise.reject(new Error("injected read failure")),
        });
        return Object.assign(Object.create(real), { bind: () => rejected });
      },
    }) as D1Database;
    const exit = await Effect.runPromiseExit(
      seatingExportService
        .seatingCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(EffectDbService, effectDbFor(failing, "fetch"))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.pretty(exit.cause)).toContain("injected read failure");
    }
  });
});
