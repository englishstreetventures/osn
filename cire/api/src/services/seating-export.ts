import {
  events,
  families,
  guests,
  rsvps,
  seatingAssignments,
  seatingPlans,
  seatingTables,
} from "@cire/db";
import { and, asc, eq, sql } from "drizzle-orm";
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
 * gift ceiling costs about what it does.
 *
 * The ceiling bounds the read as well as the file: the query orders and cuts
 * in the database at one row past it, so the Worker never receives a row it
 * will not print. A cut is logged, never silent.
 */
export const MAX_SEATING_EXPORT_ROWS = 4000;

const HEADER = ["Event", "Table", "Capacity", "Guest", "Household", "RSVP"];

const PLANS_HEADER = ["Event", "Plan", "In Use", "Table", "Capacity", "Guest", "Household", "RSVP"];

const RSVP_LABEL = {
  attending: "Attending",
  declined: "Declined",
  maybe: "Maybe",
} as const satisfies Record<"attending" | "declined" | "maybe", string>;

/** A seat, or an empty table, in any plan. */
interface PlanSeatRow {
  eventName: string;
  planName: string | null;
  selected: boolean | null;
  tableName: string;
  capacity: number;
  firstName: string | null;
  lastName: string | null;
  familyName: string | null;
  status: keyof typeof RSVP_LABEL | null;
  deactivatedAt: Date | null;
}

const replyLabel = (row: {
  deactivatedAt: Date | null;
  status: keyof typeof RSVP_LABEL | null;
}): string =>
  row.deactivatedAt !== null
    ? "Invite withdrawn"
    : row.status === null
      ? "No reply"
      : RSVP_LABEL[row.status];

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
   * The wedding's seating chart as one CSV for the venue: every guest seated
   * in each event's selected plan, in event order, then table order, then
   * household and guest order. Seated guests only — the file is who sits
   * where — and no other plan: the venue gets the plan the couple chose. A
   * guest whose household was
   * withdrawn after being seated prints with the reply `Invite withdrawn`, so
   * the file says what the chart shows. The host-preview household can never
   * be seated, and is filtered here as well. No dietary column: dietary
   * answers are special-category data and stay in the RSVP export.
   */
  seatingCsv(weddingId: string): Effect.Effect<string, never, EffectDbService> {
    return Effect.gen(function* () {
      const db = yield* EffectDbService;
      const rows = (yield* db
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
        .innerJoin(
          seatingPlans,
          and(eq(seatingPlans.eventId, events.id), eq(seatingPlans.selected, true)),
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
        .all()
        .pipe(Effect.orDie)) as SeatRow[];
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
            replyLabel(row),
          ]),
      );
    }).pipe(Effect.withSpan("cire.seating.exportCsv"));
  },

  /**
   * Every seating plan of every event, in use or not, for the whole-wedding
   * archive (`services/wedding-archive.ts`): the venue file above prints only
   * the plans in use, and a plan the couple set aside is theirs too. One row
   * per seated guest, and one with no guest for a table nobody sits at, so the
   * layout survives as well as who sits where. Event order, then each event's
   * plans oldest first, then table and household order. The same ceiling as
   * the venue file, cut one row past it in the read.
   */
  allPlansCsv(weddingId: string): Effect.Effect<string, never, EffectDbService> {
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
        .from(seatingTables)
        .innerJoin(
          events,
          and(eq(events.id, seatingTables.eventId), eq(events.weddingId, seatingTables.weddingId)),
        )
        .leftJoin(seatingPlans, eq(seatingPlans.id, seatingTables.planId))
        .leftJoin(seatingAssignments, eq(seatingAssignments.tableId, seatingTables.id))
        .leftJoin(guests, eq(guests.id, seatingAssignments.guestId))
        .leftJoin(families, and(eq(families.id, guests.familyId), eq(families.kind, "guest")))
        .leftJoin(
          rsvps,
          and(
            eq(rsvps.guestId, seatingAssignments.guestId),
            eq(rsvps.eventId, seatingAssignments.eventId),
          ),
        )
        .where(eq(seatingTables.weddingId, weddingId))
        .orderBy(
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
        .pipe(Effect.orDie)) as PlanSeatRow[];
      if (rows.length > MAX_SEATING_EXPORT_ROWS) {
        yield* Effect.logWarning("seating-plans.csv exceeds the export ceiling; cut").pipe(
          Effect.annotateLogs({ weddingId, exportCap: MAX_SEATING_EXPORT_ROWS }),
        );
      }
      return serialiseCsv(
        PLANS_HEADER,
        rows.slice(0, MAX_SEATING_EXPORT_ROWS).map((row) => {
          const seated = row.firstName !== null && row.familyName !== null;
          return [
            row.eventName,
            row.planName ?? "",
            row.selected ? "Yes" : "No",
            row.tableName,
            String(row.capacity),
            seated ? `${row.firstName} ${row.lastName ?? ""}`.trim() : "",
            seated ? (row.familyName ?? "") : "",
            seated ? replyLabel(row) : "",
          ];
        }),
      );
    }).pipe(Effect.withSpan("cire.seating.exportAllPlansCsv"));
  },
};
