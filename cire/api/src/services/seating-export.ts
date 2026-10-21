import { events, families, guests, rsvps, seatingAssignments, seatingTables } from "@cire/db";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
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
 * gift ceiling costs about what it does.
 *
 * The ceiling bounds the read as well as the file: the query orders and cuts
 * in the database at one row past it, so the Worker never receives a row it
 * will not print. A cut is logged, never silent.
 */
export const MAX_SEATING_EXPORT_ROWS = 4000;

const HEADER = ["Event", "Table", "Capacity", "Guest", "Household", "RSVP"];

const RSVP_LABEL = {
  attending: "Attending",
  declined: "Declined",
  maybe: "Maybe",
} as const satisfies Record<"attending" | "declined" | "maybe", string>;

interface SeatRow {
  eventName: string;
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
   * The wedding's seating chart as one CSV for the venue: every seated guest,
   * in event order, then table order, then household and guest order. Seated
   * guests only — the file is who sits where. A guest whose household was
   * withdrawn after being seated prints with the reply `Invite withdrawn`, so
   * the file says what the chart shows. The host-preview household can never
   * be seated, and is filtered here as well. No dietary column: dietary
   * answers are special-category data and stay in the RSVP export.
   */
  seatingCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = (yield* dbQuery(() =>
        db
          .select({
            eventName: events.name,
            tableName: seatingTables.name,
            capacity: seatingTables.capacity,
            firstName: guests.firstName,
            lastName: guests.lastName,
            familyName: families.familyName,
            status: rsvps.status,
            deactivatedAt: families.deactivatedAt,
          })
          .from(events)
          .innerJoin(seatingTables, eq(seatingTables.eventId, events.id))
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
          .orderBy(
            asc(events.sortOrder),
            asc(events.id),
            asc(seatingTables.sortOrder),
            asc(seatingTables.createdAt),
            asc(seatingTables.id),
            asc(families.familyName),
            asc(guests.familyId),
            asc(guests.sortOrder),
            asc(guests.id),
          )
          .limit(MAX_SEATING_EXPORT_ROWS + 1)
          .all(),
      )) as SeatRow[];
      if (rows.length > MAX_SEATING_EXPORT_ROWS) {
        yield* Effect.logWarning("seating.csv exceeds the export ceiling; cut").pipe(
          Effect.annotateLogs({ weddingId, exportCap: MAX_SEATING_EXPORT_ROWS }),
        );
      }
      return serialiseCsv(
        HEADER,
        rows
          .slice(0, MAX_SEATING_EXPORT_ROWS)
          .map((row) => [
            row.eventName,
            row.tableName,
            String(row.capacity),
            `${row.firstName} ${row.lastName}`.trim(),
            row.familyName,
            row.deactivatedAt !== null
              ? "Invite withdrawn"
              : row.status === null
                ? "No reply"
                : RSVP_LABEL[row.status],
          ]),
      );
    }).pipe(Effect.withSpan("cire.seating.exportCsv"));
  },
};
