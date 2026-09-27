import { describe, expect, it } from "bun:test";

import { families, guestEvents, guests } from "@cire/db";
import { and, eq, isNull, ne } from "drizzle-orm";

import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";

// `guests_plus_one_of_uniq` is PARTIAL (`WHERE plus_one_of_guest_id IS NOT
// NULL`). As a full unique index over a column that is NULL on almost every
// row, the planner costed `plus_one_of_guest_id IS NULL` as a near-unique probe
// and drove the round-trip export's reads from it — walking every wedding's
// guests to return one wedding's. These pin both halves of the fix: an
// `IS NULL` filter no longer reaches the index, and an equality probe still does.

/** The plan SQLite chooses for a Drizzle query, one detail line per step. */
function planOf(db: TestDb, query: { toSQL(): { sql: string; params: unknown[] } }): string[] {
  const { sql, params } = query.toSQL();
  const rows = db.$client.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail);
}

function seeded(): TestDb {
  const db = createDb(":memory:");
  seedDb(db);
  // No ANALYZE: without statistics the planner costs indexes by their shape,
  // which is where a full unique index made `IS NULL` look like a single row.
  return db;
}

describe("guests_plus_one_of_uniq", () => {
  it("is not what an IS NULL filter reads the export's invitations through", () => {
    const db = seeded();
    const scope = and(
      eq(families.weddingId, "wed_bootstrap"),
      ne(families.kind, "host"),
      isNull(guests.plusOneOfGuestId),
    );
    const linkRead = db
      .select({ guestId: guestEvents.guestId, eventId: guestEvents.eventId })
      .from(guestEvents)
      .innerJoin(guests, eq(guestEvents.guestId, guests.id))
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(scope);
    const guestRead = db
      .select({ id: guests.id })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(scope);
    for (const plan of [planOf(db, linkRead), planOf(db, guestRead)]) {
      expect(plan.join("\n")).not.toContain("guests_plus_one_of_uniq");
    }
  });

  it("still serves a lookup by the guest who brought them", () => {
    const db = seeded();
    const plan = planOf(
      db,
      db.select({ id: guests.id }).from(guests).where(eq(guests.plusOneOfGuestId, "g_1")),
    );
    expect(plan.join("\n")).toContain("guests_plus_one_of_uniq");
  });
});
