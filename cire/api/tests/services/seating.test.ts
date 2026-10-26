import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  seatingPlans,
  seatingTables,
} from "@cire/db";
import { Effect, Logger, References } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { MAX_CHART_GUESTS, seatingService } from "../../src/services/seating";
import { recordStatements } from "../test-helpers";

// The chart read's ceiling. The tier cap keeps every real event under it; the
// ceiling is what bounds the Worker if that ever stops holding, so it applies
// to the read, and a cut is said in a log line rather than made silently.

const EVENT = "evt_big";
const PLAN = "spl_big";

/** One event with `count` invited guests in one household. */
function invitedWedding(count: number): TestDb {
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

describe("seatingService.chart — the guest ceiling", () => {
  it("reads one guest past the ceiling, returns the ceiling's worth, and says it cut", async () => {
    const db = invitedWedding(MAX_CHART_GUESTS + 20);
    const statements = recordStatements(db);
    const { warnings, layer } = captureWarnings();
    const chart = await Effect.runPromise(
      seatingService
        .chart(BOOTSTRAP_WEDDING_ID, EVENT)
        .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
    );
    const read = statements.find((s) => /from "guest_events"/.test(s.sql))!;
    expect(read.rowCounts).toEqual([MAX_CHART_GUESTS + 1]);
    expect(chart.guests).toHaveLength(MAX_CHART_GUESTS);
    expect(warnings.map((w) => w.message)).toEqual(["seating chart read past its guest ceiling"]);
    expect(warnings[0]!.annotations).toMatchObject({
      weddingId: BOOTSTRAP_WEDDING_ID,
      eventId: EVENT,
      ceiling: MAX_CHART_GUESTS,
    });
  }, 30_000);

  it("returns a chart at the ceiling whole, and says nothing", async () => {
    const db = invitedWedding(MAX_CHART_GUESTS);
    const { warnings, layer } = captureWarnings();
    const chart = await Effect.runPromise(
      seatingService
        .chart(BOOTSTRAP_WEDDING_ID, EVENT)
        .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
    );
    expect(chart.guests).toHaveLength(MAX_CHART_GUESTS);
    expect(warnings).toEqual([]);
  }, 30_000);
});

describe("seatingService.reorderTables", () => {
  // A keyboard step swaps two neighbours; the statement writes those two and
  // leaves every other table's row alone, however many the plan holds.
  it("writes only the tables whose place changed", async () => {
    const db = invitedWedding(0);
    const longAgo = new Date("2026-01-01T00:00:00Z");
    const ids = Array.from({ length: 6 }, (_, i) => `stb_${i}`);
    db.insert(seatingPlans)
      .values({
        id: PLAN,
        weddingId: BOOTSTRAP_WEDDING_ID,
        eventId: EVENT,
        name: "Plan 1",
        selected: true,
        createdAt: longAgo,
        updatedAt: longAgo,
      })
      .run();
    db.insert(seatingTables)
      .values(
        ids.map((id, i) => ({
          id,
          weddingId: BOOTSTRAP_WEDDING_ID,
          eventId: EVENT,
          planId: PLAN,
          name: `T${i}`,
          capacity: 8,
          sortOrder: i,
          createdAt: longAgo,
          updatedAt: longAgo,
        })),
      )
      .run();
    const swapped = [...ids];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    await Effect.runPromise(
      seatingService
        .reorderTables(BOOTSTRAP_WEDDING_ID, PLAN, swapped)
        .pipe(Effect.provideService(DbService, db)),
    );
    const rows = db
      .select({
        id: seatingTables.id,
        sortOrder: seatingTables.sortOrder,
        updatedAt: seatingTables.updatedAt,
      })
      .from(seatingTables)
      .all();
    expect(rows.toSorted((a, b) => a.sortOrder - b.sortOrder).map((r) => r.id)).toEqual(swapped);
    expect(
      rows
        .filter((r) => r.updatedAt.getTime() !== longAgo.getTime())
        .map((r) => r.id)
        .toSorted(),
    ).toEqual(["stb_2", "stb_3"]);
  });
});
