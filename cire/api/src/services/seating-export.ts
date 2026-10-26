import {
  events,
  families,
  guests,
  rsvps,
  seatingAssignments,
  seatingPlans,
  seatingTables,
} from "@cire/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { EffectDbService } from "../db/effect-handle";
import { serialiseCsv } from "../lib/csv";

/**
 * Row ceiling on one seating export.
 *
 * Every seated guest at every event is one row, so a file can outgrow any one
 * chart: 1,000 guests seated at four events is 4,000 rows. The number comes
 * from the CPU budget, as the gift export's does (`MAX_GIFT_EXPORT_ROWS` in
 * `gift-export.ts`, whose comment carries the Workers measurement: about 6 ms
 * for 2,000 fourteen-cell rows against the 10 ms Workers Free allows). A
 * seating row is six short cells. Measured side by side with `serialiseCsv`,
 * 2,000 seating rows took half the time of 2,000 gift-shaped rows, so twice the
 * gift ceiling costs about what it does. The every-plan file's rows are eight
 * cells: 4,000 of them took 1.2 times as long as 2,000 gift rows (bun, median
 * of 50 runs), so about 7 ms against the 10 ms.
 *
 * The ceiling bounds the read as well as the file: the query orders and cuts
 * in the database at one row past it, so the Worker never receives a row it
 * will not print. A cut is logged, never silent. The every-plan file can pass
 * it at one event (five plans of 1,000 guests): it prints the plans in use
 * first, so a cut drops plans not in use, and the locked card, which counts
 * every seat, says when the file holds fewer.
 */
export const MAX_SEATING_EXPORT_ROWS = 4000;

const HEADER = ["Event", "Table", "Capacity", "Guest", "Household", "RSVP"];
/** Every plan's file: the venue file's columns, each row also naming its plan
 *  and whether that plan is the one in use. */
const ALL_PLANS_HEADER = [
  "Event",
  "Plan",
  "In use",
  "Table",
  "Capacity",
  "Guest",
  "Household",
  "RSVP",
];

const RSVP_LABEL = {
  attending: "Attending",
  declined: "Declined",
  maybe: "Maybe",
} as const satisfies Record<"attending" | "declined" | "maybe", string>;

interface SeatRow {
  eventName: string;
  planName: string;
  selected: boolean | number;
  tableName: string;
  capacity: number;
  firstName: string;
  lastName: string;
  familyName: string;
  status: keyof typeof RSVP_LABEL | null;
  deactivatedAt: Date | null;
}

export const seatingExportService = {
  /**
   * The wedding's seating chart as one CSV for the venue: every guest seated
   * in each event's selected plan, in event order, then table order, then
   * household and guest order. Seated guests only — the file is who sits
   * where — and no other plan: the venue gets the plan the couple chose. A
   * guest whose household was withdrawn after being seated prints with the
   * reply `Invite withdrawn`, so the file says what the chart shows. The
   * host-preview household can never be seated, and is filtered here as
   * well. No dietary column: dietary answers are special-category data and
   * stay in the RSVP export.
   *
   * With `allPlans`, every plan of every event instead: each event's plan in
   * use, then every other plan, each row naming its plan and whether it is in
   * use. It is the file a wedding below Gold takes back everything its
   * seating holds with, up to the ceiling below.
   */
  seatingCsv(
    weddingId: string,
    options: { allPlans?: boolean } = {},
  ): Effect.Effect<string, never, EffectDbService> {
    const allPlans = options.allPlans === true;
    return Effect.gen(function* () {
      const db = yield* EffectDbService;
      const rows = (yield* db
        .select({
          eventName: events.name,
          planName: seatingPlans.name,
          selected: seatingPlans.selected,
          tableName: seatingTables.name,
          capacity: seatingTables.capacity,
          firstName: guests.firstName,
          lastName: guests.lastName,
          familyName: families.familyName,
          status: rsvps.status,
          deactivatedAt: families.deactivatedAt,
        })
        .from(events)
        .innerJoin(
          seatingPlans,
          and(
            eq(seatingPlans.eventId, events.id),
            allPlans ? undefined : eq(seatingPlans.selected, true),
          ),
        )
        // A table's event, as well as its plan: the event's composite key to
        // `events (id, wedding_id)` is what ties the table to this wedding.
        // The unary `+` keeps the event term out of index choice, so the
        // tables are found by their plan.
        .innerJoin(
          seatingTables,
          and(
            eq(seatingTables.planId, seatingPlans.id),
            sql`+${seatingTables.eventId} = ${events.id}`,
          ),
        )
        .innerJoin(seatingAssignments, eq(seatingAssignments.tableId, seatingTables.id))
        .innerJoin(guests, eq(guests.id, seatingAssignments.guestId))
        .innerJoin(families, and(eq(families.id, guests.familyId), eq(families.kind, "guest")))
        .leftJoin(
          rsvps,
          and(
            eq(rsvps.guestId, seatingAssignments.guestId),
            eq(rsvps.eventId, seatingAssignments.eventId),
          ),
        )
        .where(eq(events.weddingId, weddingId))
        // Plans in use first, across every event: the venue file reads no
        // other, and if the ceiling cuts the every-plan file, it cuts plans
        // not in use first.
        .orderBy(
          desc(seatingPlans.selected),
          asc(events.sortOrder),
          asc(events.id),
          asc(seatingPlans.createdAt),
          asc(seatingPlans.id),
          asc(seatingTables.sortOrder),
          asc(seatingTables.createdAt),
          asc(seatingTables.id),
          asc(families.familyName),
          asc(guests.familyId),
          asc(guests.sortOrder),
          asc(guests.id),
        )
        .limit(MAX_SEATING_EXPORT_ROWS + 1)
        .all()
        .pipe(Effect.orDie)) as SeatRow[];
      if (rows.length > MAX_SEATING_EXPORT_ROWS) {
        yield* Effect.logWarning("seating.csv exceeds the export ceiling; cut").pipe(
          Effect.annotateLogs({ weddingId, exportCap: MAX_SEATING_EXPORT_ROWS }),
        );
      }
      return serialiseCsv(
        allPlans ? ALL_PLANS_HEADER : HEADER,
        rows.slice(0, MAX_SEATING_EXPORT_ROWS).map((row) => {
          const cells = allPlans
            ? [row.eventName, row.planName, row.selected ? "Yes" : "No"]
            : [row.eventName];
          cells.push(
            row.tableName,
            String(row.capacity),
            `${row.firstName} ${row.lastName}`.trim(),
            row.familyName,
            row.deactivatedAt !== null
              ? "Invite withdrawn"
              : row.status === null
                ? "No reply"
                : RSVP_LABEL[row.status],
          );
          return cells;
        }),
      );
    }).pipe(Effect.withSpan("cire.seating.exportCsv"));
  },
};
