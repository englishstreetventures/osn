import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, runOfShowItems } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { claimService } from "../../src/services/claim";
import {
  RUN_OF_SHOW_INSERT_BYTES,
  runOfShowFrom,
  runOfShowStatements,
} from "../../src/services/run-of-show";
import { stateExportService } from "../../src/services/state-export";
import { tableExportService } from "../../src/services/table-export";
import { recordStatements } from "../test-helpers";

/** A fresh seeded database whose first event has a two-item run of show. */
function seeded() {
  const db = createDb(":memory:");
  seedDb(db);
  const [first] = db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
    .orderBy(asc(events.sortOrder))
    .all();
  // Written out of order: the reads give the organiser's.
  db.insert(runOfShowItems)
    .values([
      {
        eventId: first!.id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        sortOrder: 1,
        time: "17:15",
        label: "B",
      },
      {
        eventId: first!.id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        sortOrder: 0,
        time: "16:00",
        label: "A",
      },
    ])
    .run();
  return { db, eventId: first!.id };
}

describe("runOfShowFrom", () => {
  it("reads the folded column in the organiser's order, and none as empty", () => {
    expect(runOfShowFrom('[[1,"17:15","B"],[0,"16:00","A"]]')).toEqual([
      { time: "16:00", label: "A" },
      { time: "17:15", label: "B" },
    ]);
    expect(runOfShowFrom("[]")).toEqual([]);
    expect(runOfShowFrom(null)).toEqual([]);
  });
});

// Every read that hands out events carries each one's run of show in the same
// statement, so a run of show costs no statement of its own.
describe("the events reads fold the run of show in", () => {
  it.each([
    ["the claim", () => claimService.lookup("TESTONE-IVY-AA11")],
    ["the organiser's events read", () => claimService.listEvents(BOOTSTRAP_WEDDING_ID, "w")],
    ["the round-trip download", () => stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "full")],
    ["the reporting download", () => tableExportService.eventsCsv(BOOTSTRAP_WEDDING_ID)],
  ] as const)("%s", async (_read, read) => {
    const { db } = seeded();
    const recorded = recordStatements(db);
    await Effect.runPromise(
      (read() as Effect.Effect<unknown, unknown, DbService>).pipe(
        Effect.provideService(DbService, db),
      ),
    );
    const touching = recorded.filter((s) => s.sql.includes("run_of_show_items"));
    expect(touching).toHaveLength(1);
    expect(touching[0]!.sql).toContain("json_group_array");
    expect(touching[0]!.sql).toMatch(/from "events"/);
  });
});

describe("runOfShowStatements", () => {
  const stored = (db: ReturnType<typeof createDb>, eventId: string) =>
    db
      .select({ time: runOfShowItems.time, label: runOfShowItems.label })
      .from(runOfShowItems)
      .where(eq(runOfShowItems.eventId, eventId))
      .orderBy(asc(runOfShowItems.sortOrder))
      .all();

  it("writes every list in one insert while they fit the byte budget", async () => {
    const { db, eventId } = seeded();
    const ids = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
      .all()
      .map((e) => e.id);
    const lists = ids.map((id, n) => ({
      eventId: id,
      items: [
        { time: "10:00", label: `First ${n}` },
        { time: "09:00", label: `Second ${n}` },
      ],
    }));
    const statements = runOfShowStatements(db, BOOTSTRAP_WEDDING_ID, lists, [eventId]);
    // One delete of the replaced list, then one insert for every list.
    expect(statements).toHaveLength(2);
    for (const statement of statements) await statement;
    for (const [n, id] of ids.entries()) {
      expect(stored(db, id)).toEqual([
        { time: "10:00", label: `First ${n}` },
        { time: "09:00", label: `Second ${n}` },
      ]);
    }
  });

  it("splits the insert past the byte budget, keeping each list's order", async () => {
    const { db, eventId } = seeded();
    const ids = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
      .all()
      .map((e) => e.id);
    // Five full lists of three-byte characters: well past one payload.
    const lists = ids.map((id) => ({
      eventId: id,
      items: Array.from({ length: 40 }, (_, i) => ({
        time: `${String(i % 24).padStart(2, "0")}:00`,
        label: `${String(i).padStart(2, "0")}${"語".repeat(198)}`,
      })),
    }));
    const statements = runOfShowStatements(db, BOOTSTRAP_WEDDING_ID, lists, [eventId]);
    expect(statements.length).toBeGreaterThan(1);
    // Each insert carries its items as one JSON parameter under the budget.
    const utf8 = new TextEncoder();
    for (const statement of statements) {
      const { params } = (statement as unknown as { toSQL(): { params: unknown[] } }).toSQL();
      const payloads = params.filter(
        (p): p is string => typeof p === "string" && p.startsWith("["),
      );
      expect(payloads).toHaveLength(1);
      expect(utf8.encode(payloads[0]).length).toBeLessThanOrEqual(RUN_OF_SHOW_INSERT_BYTES);
    }
    for (const statement of statements) await statement;
    for (const id of ids) {
      expect(stored(db, id).map((item) => item.label.slice(0, 2))).toEqual(
        Array.from({ length: 40 }, (_, i) => String(i).padStart(2, "0")),
      );
    }
  });
});
