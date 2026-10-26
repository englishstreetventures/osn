/**
 * The seating chart: an event's seating plans, the tables in each, and which
 * guest sits at which table in each plan ([[wiki/cire/cire-seating]]).
 *
 * TENANCY: the route gate proves the caller may touch `weddingId`. Every
 * statement here also scopes by it — a plan or a table through its
 * `wedding_id`, a seat through its plan's or its event's — so a plan, table or
 * event id from another wedding matches nothing and reads as not found.
 *
 * PLANS: an event holds up to {@link MAX_PLANS_PER_EVENT} plans, and at most
 * one is selected, which the database enforces with a partial unique index.
 * The first plan made at an event is selected; the selected plan cannot be
 * deleted, only replaced by selecting another. The selected plan is the one
 * the venue file reads; a chart read without a plan names it.
 *
 * ONE SEAT PER GUEST PER PLAN is the database's rule, not this file's: the
 * unique `(plan_id, guest_id)` index on `seating_assignments` refuses a second
 * seat whatever writes it, and the `(table_id, plan_id)` foreign key refuses a
 * seat outside its table's plan. The seat write below is shaped so it never
 * asks for either — a guest who already sits somewhere in the plan is moved by
 * UPDATE, never inserted again.
 *
 * WHO A CHART HOLDS: the guests invited to the event (`guest_events`), from the
 * wedding's guest households. The host-preview household never appears and
 * can never be seated. A withdrawn household (`deactivated_at` set) cannot be
 * seated or moved; its guests stay on a plan only while they still hold a seat
 * in it, so a host can see them and clear it. Nothing here moves a seat when a
 * guest's reply or invitation changes: each plan keeps the seat, and the chart
 * says what changed.
 */
import {
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  seatingAssignments,
  seatingCopyBudget,
  seatingPlans,
  seatingTables,
} from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  notExists,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { bound, commitBatchResults, type Db, DbService, dbQuery, outerColumn } from "../db";
import {
  metricSeatingPlanWrite,
  metricSeatingSeatWrite,
  metricSeatingTableWrite,
  metricSeatingWriteRefused,
} from "../metrics";
import {
  MAX_COPIED_ROWS_PER_DAY,
  MAX_PLANS_PER_EVENT,
  MAX_TABLES_PER_PLAN,
} from "../schemas/seating";

/** The event is not one of this wedding's. 404-class. */
export class SeatingEventNotFound extends Data.TaggedError("SeatingEventNotFound") {}
/** No such plan at this wedding, or at this event of it. 404-class. */
export class SeatingPlanNotFound extends Data.TaggedError("SeatingPlanNotFound") {}
/** No such table in this plan of this wedding. 404-class. */
export class SeatingTableNotFound extends Data.TaggedError("SeatingTableNotFound") {}
/** The guest is not one this plan's chart holds: another wedding's, not
 *  invited to the plan's event, the host preview, or unknown. 404-class. */
export class SeatingGuestNotFound extends Data.TaggedError("SeatingGuestNotFound") {}
/** The guest's household had its invitation withdrawn. 409-class. */
export class SeatingHouseholdWithdrawn extends Data.TaggedError("SeatingHouseholdWithdrawn") {}
/** Every seat at the table is taken. 409-class. */
export class SeatingTableFull extends Data.TaggedError("SeatingTableFull") {}
/** The plan already has {@link MAX_TABLES_PER_PLAN} tables. 409-class. */
export class SeatingTableLimit extends Data.TaggedError("SeatingTableLimit") {}
/** A capacity below the guests already seated at the table. 409-class. */
export class SeatingCapacityBelowSeated extends Data.TaggedError("SeatingCapacityBelowSeated") {}
/** The event already has {@link MAX_PLANS_PER_EVENT} plans. 409-class. */
export class SeatingPlanLimit extends Data.TaggedError("SeatingPlanLimit") {}
/** The plan is the event's selected plan, which cannot be deleted. 409-class. */
export class SeatingPlanSelected extends Data.TaggedError("SeatingPlanSelected") {}
/** The copy would take the wedding past {@link MAX_COPIED_ROWS_PER_DAY} rows
 *  copied today. 409-class. */
export class SeatingCopyBudget extends Data.TaggedError("SeatingCopyBudget") {}

/**
 * Most guests one chart read returns. The tier cap (1,000 guests on Crimson,
 * plus-ones and withdrawn households counted) keeps every real event under it;
 * the limit is what bounds the Worker if that ever stops holding.
 */
export const MAX_CHART_GUESTS = 1000;

export type RsvpStatus = "attending" | "declined" | "maybe";

export interface SeatingPlanDto {
  id: string;
  name: string;
  /** The event's selected plan: the one the venue file reads. */
  selected: boolean;
}

export interface SeatingTableDto {
  id: string;
  name: string;
  capacity: number;
  sortOrder: number;
}

export interface SeatingGuestDto {
  id: string;
  firstName: string;
  lastName: string;
  /** The guest's reply to this event, or `null` before they reply. */
  rsvp: RsvpStatus | null;
  /** The household's invitation was withdrawn. Shown only while seated. */
  withdrawn: boolean;
  /** Their table in the plan read, or `null`. */
  tableId: string | null;
}

export interface SeatingChartDto {
  /** The chart sends what the screen and the print sheet show, and no more:
   *  it is read on every event and plan switch, at up to a thousand guests. */
  event: { id: string; name: string };
  /** The event's plans, the selected one first, then oldest first. */
  plans: SeatingPlanDto[];
  /** The plan the tables and seats below are from: the one asked for, or the
   *  selected plan, or `null` for an event with no plan yet. */
  planId: string | null;
  tables: SeatingTableDto[];
  guests: SeatingGuestDto[];
}

/** Where a seat write left the guest. */
export interface SeatDto {
  guestId: string;
  tableId: string | null;
}

// ── Predicates shared by the writes ────────────────────────────────────────

/** The event is this wedding's. */
const eventOfWedding = (db: Db, weddingId: string, eventId: string) =>
  db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)));

/**
 * A plan, as an id or as the subquery that names one: the event's own
 * addresses pass `planInUseOf`, so the plan in use is read inside the
 * statement that writes, not in a round trip before it.
 */
type PlanRef = string | SQLWrapper;

/** The plan, if this wedding's. */
const planOfWedding = (db: Db, weddingId: string, planId: PlanRef) =>
  db
    .select({ id: seatingPlans.id })
    .from(seatingPlans)
    .where(and(eq(seatingPlans.id, planId), eq(seatingPlans.weddingId, weddingId)));

/** The plan's event, if the plan is this wedding's. */
const eventOfPlan = (db: Db, weddingId: string, planId: PlanRef) => {
  const p = alias(seatingPlans, "seat_plan_event");
  return db
    .select({ eventId: p.eventId })
    .from(p)
    .where(and(eq(p.id, planId), eq(p.weddingId, weddingId)));
};

/** The id of the event's plan in use, if the event is this wedding's. */
const planInUseOf = (db: Db, weddingId: string, eventId: string) =>
  db
    .select({ id: seatingPlans.id })
    .from(seatingPlans)
    .where(
      and(
        eq(seatingPlans.eventId, eventId),
        eq(seatingPlans.weddingId, weddingId),
        eq(seatingPlans.selected, true),
      ),
    );

/** `tableId` is a table in `planId` of `weddingId`. */
function tableInPlan(db: Db, weddingId: string, planId: PlanRef, tableId: string): SQL {
  const t = alias(seatingTables, "seat_target");
  return exists(
    db
      .select({ one: sql`1` })
      .from(t)
      .where(and(eq(t.id, tableId), eq(t.planId, planId), eq(t.weddingId, weddingId))),
  );
}

/** The table has a free seat. Read inside the same statement as the write, so
 *  a D1 batch — one transaction — cannot seat past it. */
function roomAt(db: Db, tableId: string): SQL {
  const seated = alias(seatingAssignments, "seat_room");
  const table = alias(seatingTables, "seat_room_table");
  return sql`${db.select({ n: count() }).from(seated).where(eq(seated.tableId, tableId))} < ${db
    .select({ capacity: table.capacity })
    .from(table)
    .where(eq(table.id, tableId))}`;
}

/** The guest belongs to an active guest household of this wedding. */
function activeGuestOfWedding(db: Db, weddingId: string, guestId: string): SQL {
  const g = alias(guests, "seat_guest");
  const f = alias(families, "seat_family");
  return exists(
    db
      .select({ one: sql`1` })
      .from(g)
      .innerJoin(f, eq(f.id, g.familyId))
      .where(
        and(
          eq(g.id, guestId),
          eq(f.weddingId, weddingId),
          eq(f.kind, "guest"),
          isNull(f.deactivatedAt),
        ),
      ),
  );
}

/** A guest's seat in the plan, if the plan is this wedding's. */
const seatInPlan = (db: Db, weddingId: string, planId: PlanRef, guestId: string) =>
  and(
    eq(seatingAssignments.planId, planId),
    eq(seatingAssignments.guestId, guestId),
    inArray(seatingAssignments.planId, planOfWedding(db, weddingId, planId)),
  );

const planColumns = {
  id: seatingPlans.id,
  name: seatingPlans.name,
  selected: seatingPlans.selected,
};

type TableRow = SeatingTableDto;
const tableColumns = {
  id: seatingTables.id,
  name: seatingTables.name,
  capacity: seatingTables.capacity,
  sortOrder: seatingTables.sortOrder,
};

/** A JSON path naming `column`'s value as a key, for a map bound as one JSON
 *  object. Ids are word characters and hyphens (the schema refuses anything
 *  else, and the API mints nothing else), which keeps them safe inside it. */
const keyPath = (column: SQL) => sql`'$."' || ${column} || '"'`;

/**
 * Why a seat write left the guest where they were. Read only on the refusal
 * path, in one round trip, and checked in the order a caller can act on: the
 * plan, then the table, then the guest, then the table's room.
 */
function diagnoseSeat(
  db: Db,
  input: { weddingId: string; planId: PlanRef; guestId: string; tableId: string },
): Effect.Effect<
  never,
  | SeatingPlanNotFound
  | SeatingTableNotFound
  | SeatingGuestNotFound
  | SeatingHouseholdWithdrawn
  | SeatingTableFull
> {
  return Effect.gen(function* () {
    const [planRows, tableRows, guestRows] = (yield* dbQuery(() =>
      commitBatchResults(db, [
        planOfWedding(db, input.weddingId, input.planId),
        db
          .select({ id: seatingTables.id })
          .from(seatingTables)
          .where(
            and(
              eq(seatingTables.id, input.tableId),
              eq(seatingTables.planId, input.planId),
              eq(seatingTables.weddingId, input.weddingId),
            ),
          ),
        db
          .select({ kind: families.kind, deactivatedAt: families.deactivatedAt })
          .from(guestEvents)
          .innerJoin(guests, eq(guests.id, guestEvents.guestId))
          .innerJoin(families, eq(families.id, guests.familyId))
          .where(
            and(
              eq(guestEvents.guestId, input.guestId),
              eq(guestEvents.eventId, eventOfPlan(db, input.weddingId, input.planId)),
              eq(families.weddingId, input.weddingId),
            ),
          ),
      ]),
    )) as [unknown[], unknown[], Array<{ kind: string; deactivatedAt: unknown }>];
    if (planRows.length === 0) return yield* Effect.fail(new SeatingPlanNotFound());
    if (tableRows.length === 0) return yield* Effect.fail(new SeatingTableNotFound());
    const guest = guestRows[0];
    if (!guest || guest.kind !== "guest") return yield* Effect.fail(new SeatingGuestNotFound());
    if (guest.deactivatedAt !== null && guest.deactivatedAt !== undefined) {
      metricSeatingWriteRefused("household_withdrawn");
      return yield* Effect.fail(new SeatingHouseholdWithdrawn());
    }
    metricSeatingWriteRefused("table_full");
    return yield* Effect.fail(new SeatingTableFull());
  });
}

/**
 * The INSERT of a table at the end of the plan's order. One statement: the
 * plan must be this wedding's, and must have room for another table — both
 * read where the row is written. The table takes the plan's own event and
 * wedding. Returns the table, or nothing when refused.
 */
function insertTable(
  db: Db,
  input: { weddingId: string; planId: PlanRef; name: string; capacity: number },
) {
  const id = `stb_${crypto.randomUUID()}`;
  const now = new Date();
  const peers = alias(seatingTables, "seat_peers");
  return db
    .insert(seatingTables)
    .select(
      // Every `seating_tables` column, in the table's order.
      db
        .select({
          id: bound(id, seatingTables.id),
          weddingId: seatingPlans.weddingId,
          eventId: seatingPlans.eventId,
          planId: seatingPlans.id,
          name: bound(input.name, seatingTables.name),
          capacity: bound(input.capacity, seatingTables.capacity),
          sortOrder: sql`coalesce(${db
            .select({ last: max(peers.sortOrder) })
            .from(peers)
            .where(eq(peers.planId, input.planId))}, -1) + 1`.as("sort_order"),
          createdAt: bound(now, seatingTables.createdAt),
          updatedAt: bound(now, seatingTables.updatedAt),
        })
        .from(seatingPlans)
        .where(
          and(
            eq(seatingPlans.id, input.planId),
            eq(seatingPlans.weddingId, input.weddingId),
            sql`${db
              .select({ n: count() })
              .from(peers)
              .where(eq(peers.planId, input.planId))} < ${MAX_TABLES_PER_PLAN}`,
          ),
        ),
    )
    .returning(tableColumns);
}

/** A plan row as SQLite returns it through a raw `RETURNING` or batch read,
 *  where a boolean column can arrive as 0 or 1. */
const asPlan = (row: { id: string; name: string; selected: unknown }): SeatingPlanDto => ({
  id: row.id,
  name: row.name,
  selected: Boolean(row.selected),
});

export const seatingService = {
  /**
   * One plan of one event: the event, every plan it has, the plan's tables in
   * order, and every guest the event holds with their seat in that plan. The
   * plan is `planId`, or the selected plan when none is named.
   */
  chart(
    weddingId: string,
    eventId: string,
    planId?: string,
  ): Effect.Effect<SeatingChartDto, SeatingEventNotFound | SeatingPlanNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // The plan read: the one named, or the event's selected plan. A plan of
      // another event or wedding matches no table and no seat here, and is
      // refused below because the event's plans do not list it.
      const viewed: SQLWrapper =
        planId !== undefined ? sql`${planId}` : planInUseOf(db, weddingId, eventId);
      const [eventRows, planRows, tableRows, guestRows] = (yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .select({
              id: events.id,
              name: events.name,
            })
            .from(events)
            .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId))),
          db
            .select(planColumns)
            .from(seatingPlans)
            .where(and(eq(seatingPlans.eventId, eventId), eq(seatingPlans.weddingId, weddingId)))
            .orderBy(
              desc(seatingPlans.selected),
              asc(seatingPlans.createdAt),
              asc(seatingPlans.id),
            ),
          db
            .select(tableColumns)
            .from(seatingTables)
            .where(
              and(
                eq(seatingTables.planId, viewed),
                eq(seatingTables.eventId, eventId),
                eq(seatingTables.weddingId, weddingId),
              ),
            )
            .orderBy(
              asc(seatingTables.sortOrder),
              asc(seatingTables.createdAt),
              asc(seatingTables.id),
            ),
          // Every result column has its own name: the D1 driver's batch path
          // keys a row by column name, so two `id`s would collapse into one.
          db
            .select({
              id: guests.id,
              firstName: guests.firstName,
              lastName: guests.lastName,
              rsvp: rsvps.status,
              deactivatedAt: families.deactivatedAt,
              tableId: seatingAssignments.tableId,
            })
            .from(guestEvents)
            .innerJoin(guests, eq(guests.id, guestEvents.guestId))
            .innerJoin(
              families,
              and(
                eq(families.id, guests.familyId),
                eq(families.weddingId, weddingId),
                eq(families.kind, "guest"),
              ),
            )
            .leftJoin(
              rsvps,
              and(eq(rsvps.guestId, guestEvents.guestId), eq(rsvps.eventId, guestEvents.eventId)),
            )
            .leftJoin(
              seatingAssignments,
              and(
                eq(seatingAssignments.planId, viewed),
                eq(seatingAssignments.guestId, guestEvents.guestId),
                eq(seatingAssignments.eventId, guestEvents.eventId),
              ),
            )
            .where(
              and(
                eq(guestEvents.eventId, eventId),
                or(isNull(families.deactivatedAt), isNotNull(seatingAssignments.tableId)),
              ),
            )
            .orderBy(
              asc(families.familyName),
              asc(guests.familyId),
              asc(guests.sortOrder),
              asc(guests.id),
            )
            .limit(MAX_CHART_GUESTS + 1),
        ]),
      )) as [
        SeatingChartDto["event"][],
        Array<{ id: string; name: string; selected: unknown }>,
        TableRow[],
        Array<Omit<SeatingGuestDto, "withdrawn"> & { deactivatedAt: unknown }>,
      ];
      const event = eventRows[0];
      if (!event) return yield* Effect.fail(new SeatingEventNotFound());
      const plans = planRows.map(asPlan);
      const read =
        planId !== undefined
          ? plans.find((plan) => plan.id === planId)
          : plans.find((plan) => plan.selected);
      if (planId !== undefined && !read) return yield* Effect.fail(new SeatingPlanNotFound());
      if (guestRows.length > MAX_CHART_GUESTS) {
        yield* Effect.logWarning("seating chart read past its guest ceiling").pipe(
          Effect.annotateLogs({ weddingId, eventId, ceiling: MAX_CHART_GUESTS }),
        );
      }
      return {
        event,
        plans,
        planId: read?.id ?? null,
        tables: tableRows,
        guests: guestRows.slice(0, MAX_CHART_GUESTS).map((row): SeatingGuestDto => ({
          id: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
          rsvp: row.rsvp,
          withdrawn: row.deactivatedAt !== null && row.deactivatedAt !== undefined,
          tableId: row.tableId,
        })),
      };
    }).pipe(Effect.withSpan("cire.seating.chart"));
  },

  /**
   * A new plan at the event: blank, or a copy of `copyFrom` — another plan of
   * the same event — with every table (name, seats, place in the order) and
   * every seat, under new ids. The event's first plan is selected.
   *
   * A copy reads the source's table ids, then writes the plan, its tables and
   * its seats in one batch, which D1 runs as one transaction. The plan's INSERT
   * carries every rule in its own WHERE — the event is this wedding's, it has
   * room for another plan, the source is a plan of it, and the source's tables
   * and seats fit in what the wedding may still copy today — and the tables,
   * seats and the day's count are written only where the new plan exists, so a
   * refused copy writes nothing. A table added to the source between the read
   * and the batch is not in the map of new ids, so neither it nor its seats are
   * copied.
   */
  createPlan(input: {
    weddingId: string;
    eventId: string;
    name: string;
    copyFrom?: string;
  }): Effect.Effect<
    SeatingPlanDto,
    SeatingEventNotFound | SeatingPlanNotFound | SeatingPlanLimit | SeatingCopyBudget,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, eventId, copyFrom } = input;
      const id = `spl_${crypto.randomUUID()}`;
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const peers = alias(seatingPlans, "plan_peers");
      const source = alias(seatingPlans, "plan_source");
      const spent = alias(seatingCopyBudget, "copy_spent");
      const costTables = alias(seatingTables, "copy_cost_table");
      const costSeats = alias(seatingAssignments, "copy_cost_seat");
      // The rows a copy of `from` writes: its tables and its seats.
      const copyCost = (from: string) =>
        sql`${db
          .select({ n: count() })
          .from(costTables)
          .where(
            and(eq(costTables.planId, from), eq(costTables.weddingId, weddingId)),
          )} + ${db.select({ n: count() }).from(costSeats).where(eq(costSeats.planId, from))}`;

      const planInsert = db
        .insert(seatingPlans)
        .select(
          // Every `seating_plans` column, in the table's order.
          db
            .select({
              id: bound(id, seatingPlans.id),
              weddingId: events.weddingId,
              eventId: events.id,
              name: bound(input.name, seatingPlans.name),
              selected: sql`${notExists(
                db
                  .select({ one: sql`1` })
                  .from(peers)
                  .where(and(eq(peers.eventId, eventId), eq(peers.selected, true))),
              )}`.as("selected"),
              createdAt: bound(now, seatingPlans.createdAt),
              updatedAt: bound(now, seatingPlans.updatedAt),
            })
            .from(events)
            .where(
              and(
                eq(events.id, eventId),
                eq(events.weddingId, weddingId),
                sql`${db
                  .select({ n: count() })
                  .from(peers)
                  .where(eq(peers.eventId, eventId))} < ${MAX_PLANS_PER_EVENT}`,
                copyFrom === undefined
                  ? undefined
                  : exists(
                      db
                        .select({ one: sql`1` })
                        .from(source)
                        .where(
                          and(
                            eq(source.id, copyFrom),
                            eq(source.eventId, eventId),
                            eq(source.weddingId, weddingId),
                          ),
                        ),
                    ),
                copyFrom === undefined
                  ? undefined
                  : sql`coalesce(${db
                      .select({ copied: spent.copied })
                      .from(spent)
                      .where(
                        and(eq(spent.day, day), eq(spent.weddingId, weddingId)),
                      )}, 0) + ${copyCost(copyFrom)} <= ${MAX_COPIED_ROWS_PER_DAY}`,
              ),
            ),
        )
        .returning(planColumns);

      let created: Array<{ id: string; name: string; selected: unknown }>;
      if (copyFrom === undefined) {
        created = yield* dbQuery(() => planInsert.all());
      } else {
        // Old table id → new table id, for every table of the source.
        const sourceTables = yield* dbQuery(() =>
          db
            .select({ id: seatingTables.id })
            .from(seatingTables)
            .where(and(eq(seatingTables.planId, copyFrom), eq(seatingTables.weddingId, weddingId)))
            .all(),
        );
        const tableMap = JSON.stringify(
          Object.fromEntries(sourceTables.map((t) => [t.id, `stb_${crypto.randomUUID()}`])),
        );
        // True only once the new plan exists, which it does only if every rule
        // its INSERT carries held.
        const planWritten = exists(
          db
            .select({ one: sql`1` })
            .from(source)
            .where(eq(source.id, id)),
        );
        const fromTable = alias(seatingTables, "copy_table");
        const fromSeat = alias(seatingAssignments, "copy_seat");
        const tablePath = keyPath(outerColumn(fromTable.id));
        const seatPath = keyPath(outerColumn(fromSeat.tableId));
        const [, plans] = (yield* dbQuery(() =>
          commitBatchResults(db, [
            // Earlier days' counts, any wedding's: only today's is read.
            db.delete(seatingCopyBudget).where(lt(seatingCopyBudget.day, day)),
            planInsert,
            db
              .insert(seatingCopyBudget)
              .select(
                // Every `seating_copy_budget` column, in the table's order.
                db
                  .select({
                    weddingId: source.weddingId,
                    day: bound(day, seatingCopyBudget.day),
                    copied: sql`${copyCost(copyFrom)}`.as("copied"),
                  })
                  .from(source)
                  .where(eq(source.id, id)),
              )
              .onConflictDoUpdate({
                target: [seatingCopyBudget.day, seatingCopyBudget.weddingId],
                set: { copied: sql`${seatingCopyBudget.copied} + excluded.copied` },
              }),
            db.insert(seatingTables).select(
              // Every `seating_tables` column, in the table's order.
              db
                .select({
                  id: sql`json_extract(${tableMap}, ${tablePath})`.as("id"),
                  weddingId: fromTable.weddingId,
                  eventId: fromTable.eventId,
                  planId: bound(id, seatingTables.planId),
                  name: fromTable.name,
                  capacity: fromTable.capacity,
                  // Each table's place in the source's own order, which breaks
                  // a tie on `sort_order` by creation and then id: the copies
                  // share one creation time and have new ids, so a copied tie
                  // would otherwise reorder.
                  sortOrder:
                    sql`row_number() over (order by ${fromTable.sortOrder}, ${fromTable.createdAt}, ${fromTable.id}) - 1`.as(
                      "sort_order",
                    ),
                  createdAt: bound(now, seatingTables.createdAt),
                  updatedAt: bound(now, seatingTables.updatedAt),
                })
                .from(fromTable)
                .where(
                  and(
                    eq(fromTable.planId, copyFrom),
                    eq(fromTable.weddingId, weddingId),
                    sql`json_type(${tableMap}, ${tablePath}) IS NOT NULL`,
                    planWritten,
                  ),
                ),
            ),
            db.insert(seatingAssignments).select(
              // Every `seating_assignments` column, in the table's order.
              db
                .select({
                  tableId: sql`json_extract(${tableMap}, ${seatPath})`.as("table_id"),
                  planId: bound(id, seatingAssignments.planId),
                  eventId: fromSeat.eventId,
                  guestId: fromSeat.guestId,
                  createdAt: bound(now, seatingAssignments.createdAt),
                })
                .from(fromSeat)
                .where(
                  and(
                    eq(fromSeat.planId, copyFrom),
                    sql`json_type(${tableMap}, ${seatPath}) IS NOT NULL`,
                    planWritten,
                  ),
                ),
            ),
          ]),
        )) as [unknown, Array<{ id: string; name: string; selected: unknown }>];
        created = plans;
      }

      const plan = created[0];
      if (plan) {
        metricSeatingPlanWrite(copyFrom === undefined ? "create" : "duplicate");
        return asPlan(plan);
      }
      const [eventRows, sourceRows, planCount] = (yield* dbQuery(() =>
        commitBatchResults(db, [
          eventOfWedding(db, weddingId, eventId),
          db
            .select({ id: seatingPlans.id })
            .from(seatingPlans)
            .where(
              and(
                eq(seatingPlans.id, copyFrom ?? ""),
                eq(seatingPlans.eventId, eventId),
                eq(seatingPlans.weddingId, weddingId),
              ),
            ),
          db.select({ n: count() }).from(seatingPlans).where(eq(seatingPlans.eventId, eventId)),
        ]),
      )) as [unknown[], unknown[], Array<{ n: number }>];
      if (eventRows.length === 0) return yield* Effect.fail(new SeatingEventNotFound());
      if (copyFrom !== undefined && sourceRows.length === 0) {
        return yield* Effect.fail(new SeatingPlanNotFound());
      }
      // The event had room, so the copy was refused for what it would write.
      if (copyFrom !== undefined && (planCount[0]?.n ?? 0) < MAX_PLANS_PER_EVENT) {
        metricSeatingWriteRefused("copy_budget");
        return yield* Effect.fail(new SeatingCopyBudget());
      }
      metricSeatingWriteRefused("plan_limit");
      return yield* Effect.fail(new SeatingPlanLimit());
    }).pipe(Effect.withSpan("cire.seating.createPlan"));
  },

  /** Rename a plan. Whether it is selected is left as it is. */
  renamePlan(input: {
    weddingId: string;
    planId: string;
    name: string;
  }): Effect.Effect<SeatingPlanDto, SeatingPlanNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [renamed] = yield* dbQuery(() =>
        db
          .update(seatingPlans)
          .set({ name: input.name, updatedAt: new Date() })
          .where(
            and(eq(seatingPlans.id, input.planId), eq(seatingPlans.weddingId, input.weddingId)),
          )
          .returning(planColumns)
          .all(),
      );
      if (!renamed) return yield* Effect.fail(new SeatingPlanNotFound());
      metricSeatingPlanWrite("rename");
      return asPlan(renamed);
    }).pipe(Effect.withSpan("cire.seating.renamePlan"));
  },

  /** Delete a plan that is not selected. Its tables, and their seats, cascade
   *  with it; no other plan changes. */
  removePlan(
    weddingId: string,
    planId: string,
  ): Effect.Effect<void, SeatingPlanNotFound | SeatingPlanSelected, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [removed] = yield* dbQuery(() =>
        db
          .delete(seatingPlans)
          .where(
            and(
              eq(seatingPlans.id, planId),
              eq(seatingPlans.weddingId, weddingId),
              eq(seatingPlans.selected, false),
            ),
          )
          .returning({ id: seatingPlans.id })
          .all(),
      );
      if (removed) {
        metricSeatingPlanWrite("remove");
        return;
      }
      const [found] = yield* dbQuery(() => planOfWedding(db, weddingId, planId).all());
      if (!found) return yield* Effect.fail(new SeatingPlanNotFound());
      metricSeatingWriteRefused("plan_selected");
      return yield* Effect.fail(new SeatingPlanSelected());
    }).pipe(Effect.withSpan("cire.seating.removePlan"));
  },

  /**
   * Make `planId` the event's selected plan, in one batch that D1 runs as one
   * transaction. The selected plan is cleared only when `planId` is a plan of
   * this event of this wedding, then `planId` is selected. Two statements,
   * because SQLite checks the one-selected index row by row, and a single
   * UPDATE could select the new plan before clearing the old one.
   */
  selectPlan(input: {
    weddingId: string;
    eventId: string;
    planId: string;
  }): Effect.Effect<void, SeatingPlanNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, eventId, planId } = input;
      const now = new Date();
      const target = alias(seatingPlans, "plan_target");
      const ofEvent = and(eq(seatingPlans.eventId, eventId), eq(seatingPlans.weddingId, weddingId));
      const [, selected] = (yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .update(seatingPlans)
            .set({ selected: false, updatedAt: now })
            .where(
              and(
                ofEvent,
                eq(seatingPlans.selected, true),
                ne(seatingPlans.id, planId),
                exists(
                  db
                    .select({ one: sql`1` })
                    .from(target)
                    .where(
                      and(
                        eq(target.id, planId),
                        eq(target.eventId, eventId),
                        eq(target.weddingId, weddingId),
                      ),
                    ),
                ),
              ),
            ),
          db
            .update(seatingPlans)
            .set({ selected: true, updatedAt: now })
            .where(and(ofEvent, eq(seatingPlans.id, planId)))
            .returning({ id: seatingPlans.id }),
        ]),
      )) as [unknown, unknown[]];
      if (selected.length === 0) return yield* Effect.fail(new SeatingPlanNotFound());
      metricSeatingPlanWrite("select");
    }).pipe(Effect.withSpan("cire.seating.selectPlan"));
  },

  /** Add a table at the end of the plan's order. */
  createTable(input: {
    weddingId: string;
    planId: string;
    name: string;
    capacity: number;
  }): Effect.Effect<SeatingTableDto, SeatingPlanNotFound | SeatingTableLimit, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [created] = (yield* dbQuery(() => insertTable(db, input).all())) as TableRow[];
      if (created) {
        metricSeatingTableWrite("create");
        return created;
      }
      const [plan] = yield* dbQuery(() => planOfWedding(db, input.weddingId, input.planId).all());
      if (!plan) return yield* Effect.fail(new SeatingPlanNotFound());
      metricSeatingWriteRefused("table_limit");
      return yield* Effect.fail(new SeatingTableLimit());
    }).pipe(Effect.withSpan("cire.seating.createTable"));
  },

  /** Rename a table or change its capacity. A capacity below the guests
   *  already seated is refused in the same statement that would write it. */
  updateTable(input: {
    weddingId: string;
    tableId: string;
    name?: string;
    capacity?: number;
  }): Effect.Effect<SeatingTableDto, SeatingTableNotFound | SeatingCapacityBelowSeated, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const ofWedding = and(
        eq(seatingTables.id, input.tableId),
        eq(seatingTables.weddingId, input.weddingId),
      );
      const set: Partial<typeof seatingTables.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.capacity !== undefined) set.capacity = input.capacity;
      if (Object.keys(set).length === 0) {
        const [row] = (yield* dbQuery(() =>
          db.select(tableColumns).from(seatingTables).where(ofWedding).all(),
        )) as TableRow[];
        if (!row) return yield* Effect.fail(new SeatingTableNotFound());
        return row;
      }
      const seated = alias(seatingAssignments, "seat_seated");
      const [updated] = (yield* dbQuery(() =>
        db
          .update(seatingTables)
          .set({ ...set, updatedAt: new Date() })
          .where(
            and(
              ofWedding,
              input.capacity === undefined
                ? undefined
                : sql`${db
                    .select({ n: count() })
                    .from(seated)
                    .where(eq(seated.tableId, input.tableId))} <= ${input.capacity}`,
            ),
          )
          .returning(tableColumns)
          .all(),
      )) as TableRow[];
      if (updated) {
        metricSeatingTableWrite("update");
        return updated;
      }
      const [found] = yield* dbQuery(() =>
        db.select({ id: seatingTables.id }).from(seatingTables).where(ofWedding).all(),
      );
      if (!found) return yield* Effect.fail(new SeatingTableNotFound());
      metricSeatingWriteRefused("capacity_below_seated");
      return yield* Effect.fail(new SeatingCapacityBelowSeated());
    }).pipe(Effect.withSpan("cire.seating.updateTable"));
  },

  /** Delete a table. Its guests become unseated in its plan: their seats
   *  cascade with it. */
  removeTable(
    weddingId: string,
    tableId: string,
  ): Effect.Effect<void, SeatingTableNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [removed] = yield* dbQuery(() =>
        db
          .delete(seatingTables)
          .where(and(eq(seatingTables.id, tableId), eq(seatingTables.weddingId, weddingId)))
          .returning({ id: seatingTables.id })
          .all(),
      );
      if (!removed) return yield* Effect.fail(new SeatingTableNotFound());
      metricSeatingTableWrite("remove");
    }).pipe(Effect.withSpan("cire.seating.removeTable"));
  },

  /**
   * Give the plan's tables the order of `orderedIds`. One statement, so the
   * order lands whole or not at all: each table reads its new place from one
   * bound JSON object keyed by id, and only a table whose place changed is
   * written, so a keyboard step writes the two tables it swaps. An id that is
   * not a table in this plan of this wedding matches no row.
   */
  reorderTables(
    weddingId: string,
    planId: string | SQLWrapper,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      if (orderedIds.length === 0) return;
      const places = JSON.stringify(
        Object.fromEntries(orderedIds.map((id, place) => [id, place] as const)),
      );
      const path = keyPath(outerColumn(seatingTables.id));
      const place = sql`json_extract(${places}, ${path})`;
      yield* dbQuery(() =>
        db
          .update(seatingTables)
          .set({ sortOrder: place, updatedAt: new Date() })
          .where(
            and(
              eq(seatingTables.planId, planId),
              eq(seatingTables.weddingId, weddingId),
              sql`json_type(${places}, ${path}) IS NOT NULL`,
              sql`${seatingTables.sortOrder} IS NOT ${place}`,
            ),
          )
          .run(),
      );
      metricSeatingTableWrite("reorder");
    }).pipe(Effect.withSpan("cire.seating.reorderTables"));
  },

  /**
   * Put a guest at a table of the plan, move them to another, or (with
   * `tableId: null`) clear their seat in the plan. No other plan changes.
   *
   * A seat or a move is one batch — one transaction on D1 — of three
   * statements: a conditional UPDATE that moves an existing seat, a
   * conditional INSERT that seats a guest with none, and the seat after. Each
   * write carries every rule in its own WHERE (the table is this plan's, it has
   * room, the household is active; a new seat also needs the guest invited to
   * the plan's event, which a guest who already holds one in the plan is), so a
   * refused move changes nothing and the guest keeps the seat they had. Only
   * the refusal path reads again, to say why.
   *
   * `planId` may be the subquery `planInUseOf`, so the event's own address
   * seats in its plan in use in the same batch; with no such plan it reads as
   * a plan not found.
   */
  seat(input: {
    weddingId: string;
    planId: PlanRef;
    guestId: string;
    tableId: string | null;
  }): Effect.Effect<
    SeatDto,
    | SeatingPlanNotFound
    | SeatingTableNotFound
    | SeatingGuestNotFound
    | SeatingHouseholdWithdrawn
    | SeatingTableFull,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, planId, guestId, tableId } = input;

      if (tableId === null) {
        const [planRows, removed] = (yield* dbQuery(() =>
          commitBatchResults(db, [
            planOfWedding(db, weddingId, planId),
            db
              .delete(seatingAssignments)
              .where(seatInPlan(db, weddingId, planId, guestId))
              .returning({ tableId: seatingAssignments.tableId }),
          ]),
        )) as [unknown[], Array<{ tableId: string }>];
        if (planRows.length === 0) return yield* Effect.fail(new SeatingPlanNotFound());
        if (removed.length > 0) metricSeatingSeatWrite("unseat");
        return { guestId, tableId: null };
      }

      const now = new Date();
      const existing = alias(seatingAssignments, "seat_existing");
      const results = yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .update(seatingAssignments)
            .set({ tableId })
            .where(
              and(
                eq(seatingAssignments.planId, planId),
                eq(seatingAssignments.guestId, guestId),
                ne(seatingAssignments.tableId, tableId),
                tableInPlan(db, weddingId, planId, tableId),
                roomAt(db, tableId),
                activeGuestOfWedding(db, weddingId, guestId),
              ),
            )
            .returning({ tableId: seatingAssignments.tableId }),
          db
            .insert(seatingAssignments)
            .select(
              // Every `seating_assignments` column, in the table's order.
              db
                .select({
                  tableId: bound(tableId, seatingAssignments.tableId),
                  planId:
                    typeof planId === "string"
                      ? bound(planId, seatingAssignments.planId)
                      : sql`${planId}`.as("plan_id"),
                  eventId: guestEvents.eventId,
                  guestId: guestEvents.guestId,
                  createdAt: bound(now, seatingAssignments.createdAt),
                })
                .from(guestEvents)
                .where(
                  and(
                    eq(guestEvents.guestId, guestId),
                    eq(guestEvents.eventId, eventOfPlan(db, weddingId, planId)),
                    activeGuestOfWedding(db, weddingId, guestId),
                    tableInPlan(db, weddingId, planId, tableId),
                    roomAt(db, tableId),
                    notExists(
                      db
                        .select({ one: sql`1` })
                        .from(existing)
                        .where(and(eq(existing.planId, planId), eq(existing.guestId, guestId))),
                    ),
                  ),
                ),
            )
            .onConflictDoNothing()
            .returning({ tableId: seatingAssignments.tableId }),
          db
            .select({ tableId: seatingAssignments.tableId })
            .from(seatingAssignments)
            .where(seatInPlan(db, weddingId, planId, guestId)),
        ]),
      );
      // The writes say what they did, inside the same transaction: a moved
      // seat comes back from the UPDATE, a new one from the INSERT, and a seat
      // already at this table from neither.
      const moved = (results[0] as unknown[]).length > 0;
      const seated = (results[1] as unknown[]).length > 0;
      const after = (results[2] as Array<{ tableId: string }>)[0]?.tableId ?? null;
      if (after !== tableId) {
        return yield* diagnoseSeat(db, { weddingId, planId, guestId, tableId });
      }
      if (seated) metricSeatingSeatWrite("seat");
      else if (moved) metricSeatingSeatWrite("move");
      return { guestId, tableId };
    }).pipe(Effect.withSpan("cire.seating.seat"));
  },

  // ── The event's plan in use, through the event's own addresses ──────────

  /**
   * Add a table to the event's plan in use, making that plan, "Plan 1", when
   * the event has none. One batch, which D1 runs as one transaction: the plan
   * written only where the event is this wedding's and has no plan in use (the
   * partial unique index refuses a second, and the conflict is ignored), then
   * the table, as `createTable` writes it, into the plan in use read inside its
   * own INSERT. Only a refusal reads again, to say why.
   */
  createTableAtEvent(input: {
    weddingId: string;
    eventId: string;
    name: string;
    capacity: number;
  }): Effect.Effect<SeatingTableDto, SeatingEventNotFound | SeatingTableLimit, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, eventId } = input;
      const now = new Date();
      const inUse = alias(seatingPlans, "plan_in_use");
      const [made, created] = (yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .insert(seatingPlans)
            .select(
              // Every `seating_plans` column, in the table's order.
              db
                .select({
                  id: bound(`spl_${crypto.randomUUID()}`, seatingPlans.id),
                  weddingId: events.weddingId,
                  eventId: events.id,
                  name: bound("Plan 1", seatingPlans.name),
                  selected: bound(true, seatingPlans.selected),
                  createdAt: bound(now, seatingPlans.createdAt),
                  updatedAt: bound(now, seatingPlans.updatedAt),
                })
                .from(events)
                .where(
                  and(
                    eq(events.id, eventId),
                    eq(events.weddingId, weddingId),
                    notExists(
                      db
                        .select({ one: sql`1` })
                        .from(inUse)
                        .where(and(eq(inUse.eventId, eventId), eq(inUse.selected, true))),
                    ),
                  ),
                ),
            )
            .onConflictDoNothing()
            .returning({ id: seatingPlans.id }),
          insertTable(db, {
            weddingId,
            planId: planInUseOf(db, weddingId, eventId),
            name: input.name,
            capacity: input.capacity,
          }),
        ]),
      )) as [unknown[], TableRow[]];
      if (made.length > 0) metricSeatingPlanWrite("create");
      const table = created[0];
      if (table) {
        metricSeatingTableWrite("create");
        return table;
      }
      // The event, if it is this wedding's, has a plan in use now: the batch
      // made one where it had none. So only a full plan refuses a table.
      const [event] = yield* dbQuery(() => eventOfWedding(db, weddingId, eventId).all());
      if (!event) return yield* Effect.fail(new SeatingEventNotFound());
      metricSeatingWriteRefused("table_limit");
      return yield* Effect.fail(new SeatingTableLimit());
    }).pipe(Effect.withSpan("cire.seating.createTableAtEvent"));
  },

  /** `reorderTables` on the event's plan in use; nothing for an event that is
   *  not this wedding's or has no plan. */
  reorderTablesAtEvent(
    weddingId: string,
    eventId: string,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* seatingService.reorderTables(
        weddingId,
        planInUseOf(db, weddingId, eventId),
        orderedIds,
      );
    });
  },

  /** `seat` in the event's plan in use, read inside the seat's own batch. An
   *  event with no plan seats nobody: clearing a seat there is a no-op, and a
   *  table is not found. Only a refusal reads again, to say why. */
  seatAtEvent(input: {
    weddingId: string;
    eventId: string;
    guestId: string;
    tableId: string | null;
  }): Effect.Effect<
    SeatDto,
    | SeatingEventNotFound
    | SeatingTableNotFound
    | SeatingGuestNotFound
    | SeatingHouseholdWithdrawn
    | SeatingTableFull,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, eventId, guestId, tableId } = input;
      return yield* seatingService
        .seat({ weddingId, planId: planInUseOf(db, weddingId, eventId), guestId, tableId })
        .pipe(
          // No plan in use: the event is not this wedding's, or has no plan.
          Effect.catchTag("SeatingPlanNotFound", () =>
            Effect.gen(function* () {
              const [event] = yield* dbQuery(() => eventOfWedding(db, weddingId, eventId).all());
              if (!event) return yield* Effect.fail(new SeatingEventNotFound());
              if (tableId === null) return { guestId, tableId: null };
              return yield* Effect.fail(new SeatingTableNotFound());
            }),
          ),
        );
    }).pipe(Effect.withSpan("cire.seating.seatAtEvent"));
  },
};

/** Rows of one plan a change removes. */
type PlanCount = { planId: string | null; n: number };

/** What a guest-list change would take off the seating plans. */
export interface SeatingLoss {
  /** Seats, counted in every plan: a guest seated in two plans is two. */
  seats: number;
  /** Tables, counted in every plan. */
  tables: number;
  /** How many plans lose a seat or a table. */
  plans: number;
}

/**
 * How many seats and tables a change to the guest list or the schedule would
 * remove, in every plan: the seats of removed guests, of removed (guest,
 * event) invitations and of removed events, and the removed events' tables.
 * One batch of two reads, each counted by plan, only when the change removes
 * one of the three; a plan losing both is one plan. Every list
 * rides as one bound `json_each` parameter, so a change of any size stays
 * inside D1's 100-parameter limit; a pair is `guest_id` and `event_id` joined
 * by the unit separator, which no id contains.
 */
export function seatingLoss(
  weddingId: string,
  removed: {
    guestIds: readonly string[];
    eventIds: readonly string[];
    links: readonly { guestId: string; eventId: string }[];
  },
): Effect.Effect<SeatingLoss, never, DbService> {
  return Effect.gen(function* () {
    if (
      removed.guestIds.length === 0 &&
      removed.eventIds.length === 0 &&
      removed.links.length === 0
    ) {
      return { seats: 0, tables: 0, plans: 0 };
    }
    const db = yield* DbService;
    const pairs = removed.links.map((link) => `${link.guestId}\u001f${link.eventId}`);
    const weddingEvents = () =>
      db.select({ id: events.id }).from(events).where(eq(events.weddingId, weddingId));
    const lostSeat = and(
      // Through the wedding's events, whose ids lead the seats' event index.
      inArray(seatingAssignments.eventId, weddingEvents()),
      or(
        inArray(seatingAssignments.guestId, jsonEachIn(removed.guestIds)),
        inArray(seatingAssignments.eventId, jsonEachIn(removed.eventIds)),
        inArray(
          sql`${seatingAssignments.guestId} || char(31) || ${seatingAssignments.eventId}`,
          jsonEachIn(pairs),
        ),
      ),
    );
    const lostTable = and(
      inArray(seatingTables.eventId, jsonEachIn(removed.eventIds)),
      eq(seatingTables.weddingId, weddingId),
    );
    const [seatsByPlan, tablesByPlan] = (yield* dbQuery(() =>
      commitBatchResults(db, [
        db
          .select({ planId: seatingAssignments.planId, n: count() })
          .from(seatingAssignments)
          .where(lostSeat)
          .groupBy(seatingAssignments.planId),
        db
          .select({ planId: seatingTables.planId, n: count() })
          .from(seatingTables)
          .where(lostTable)
          .groupBy(seatingTables.planId),
      ]),
    )) as [PlanCount[], PlanCount[]];
    const sum = (rows: PlanCount[]) => rows.reduce((total, row) => total + Number(row.n), 0);
    return {
      seats: sum(seatsByPlan),
      tables: sum(tablesByPlan),
      plans: new Set([...seatsByPlan, ...tablesByPlan].map((row) => row.planId)).size,
    };
  }).pipe(Effect.withSpan("cire.seating.loss"));
}

/** The preview's warning for a change that takes seats or tables off the
 *  seating plans, or `null` when it takes neither. A revert restores guests
 *  and events from a before-image that holds no seating, so the loss is final. */
export function seatingLossWarning(loss: SeatingLoss): string | null {
  const parts: string[] = [];
  if (loss.seats > 0) parts.push(`clears ${loss.seats} ${loss.seats === 1 ? "seat" : "seats"}`);
  if (loss.tables > 0) {
    parts.push(`removes ${loss.tables} ${loss.tables === 1 ? "table" : "tables"}`);
  }
  if (parts.length === 0) return null;
  const from = loss.plans > 1 ? `${loss.plans} seating plans` : "the seating chart";
  return `This change ${parts.join(" and ")} from ${from}. Reverting it does not bring them back.`;
}
