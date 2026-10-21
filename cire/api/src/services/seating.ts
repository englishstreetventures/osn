/**
 * The seating chart: tables at one event, and which guest sits at which table
 * ([[wiki/cire/cire-seating]]).
 *
 * TENANCY: the route gate proves the caller may touch `weddingId`. Every
 * statement here also scopes by it — a table through its `wedding_id`, a seat
 * through its event's — so a table or event id from another wedding matches
 * nothing and reads as not found.
 *
 * ONE SEAT PER GUEST PER EVENT is the database's rule, not this file's: the
 * unique `(event_id, guest_id)` index on `seating_assignments` refuses a second
 * seat whatever writes it. The seat write below is shaped so it never asks for
 * one — a guest who already sits somewhere is moved by UPDATE, never inserted
 * again.
 *
 * WHO A CHART HOLDS: the guests invited to the event (`guest_events`), from the
 * wedding's guest households. The host-preview household never appears and
 * can never be seated. A withdrawn household (`deactivated_at` set) cannot be
 * seated or moved; its guests stay on the chart only while they still hold a
 * seat, so a host can see them and clear it.
 */
import {
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  seatingAssignments,
  seatingTables,
  weddings,
} from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { bound, commitBatchResults, type Db, DbService, dbQuery, outerColumn } from "../db";
import {
  metricSeatingSeatWrite,
  metricSeatingTableWrite,
  metricSeatingWriteRefused,
} from "../metrics";
import { MAX_TABLES_PER_EVENT } from "../schemas/seating";

/** The event is not one of this wedding's. 404-class. */
export class SeatingEventNotFound extends Data.TaggedError("SeatingEventNotFound") {}
/** No such table at this event of this wedding. 404-class. */
export class SeatingTableNotFound extends Data.TaggedError("SeatingTableNotFound") {}
/** The guest is not one this event's chart holds: another wedding's, not
 *  invited, the host preview, or unknown. 404-class. */
export class SeatingGuestNotFound extends Data.TaggedError("SeatingGuestNotFound") {}
/** The guest's household had its invitation withdrawn. 409-class. */
export class SeatingHouseholdWithdrawn extends Data.TaggedError("SeatingHouseholdWithdrawn") {}
/** Every seat at the table is taken. 409-class. */
export class SeatingTableFull extends Data.TaggedError("SeatingTableFull") {}
/** The event already has {@link MAX_TABLES_PER_EVENT} tables. 409-class. */
export class SeatingTableLimit extends Data.TaggedError("SeatingTableLimit") {}
/** A capacity below the guests already seated at the table. 409-class. */
export class SeatingCapacityBelowSeated extends Data.TaggedError("SeatingCapacityBelowSeated") {}

/**
 * Most guests one chart read returns. The tier cap (1,000 guests on Crimson,
 * plus-ones and withdrawn households counted) keeps every real event under it;
 * the limit is what bounds the Worker if that ever stops holding.
 */
export const MAX_CHART_GUESTS = 1000;

export type RsvpStatus = "attending" | "declined" | "maybe";

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
  tableId: string | null;
}

export interface SeatingChartDto {
  /** The chart sends what the screen and the print sheet show, and no more:
   *  it is read on every event switch, at up to a thousand guests. */
  event: { id: string; name: string };
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

/** `tableId` is a table at `eventId` of `weddingId`. */
function tableAtEvent(db: Db, weddingId: string, eventId: string, tableId: string): SQL {
  const t = alias(seatingTables, "seat_target");
  return exists(
    db
      .select({ one: sql`1` })
      .from(t)
      .where(and(eq(t.id, tableId), eq(t.eventId, eventId), eq(t.weddingId, weddingId))),
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

/** The guest's seat at the event, if this wedding's event. */
const seatOf = (db: Db, weddingId: string, eventId: string, guestId: string) =>
  db
    .select({ tableId: seatingAssignments.tableId })
    .from(seatingAssignments)
    .where(
      and(
        eq(seatingAssignments.eventId, eventId),
        eq(seatingAssignments.guestId, guestId),
        inArray(seatingAssignments.eventId, eventOfWedding(db, weddingId, eventId)),
      ),
    );

type TableRow = SeatingTableDto;
const tableColumns = {
  id: seatingTables.id,
  name: seatingTables.name,
  capacity: seatingTables.capacity,
  sortOrder: seatingTables.sortOrder,
};

/**
 * Why a seat write left the guest where they were. Read only on the refusal
 * path, in one round trip, and checked in the order a caller can act on: the
 * event, then the table, then the guest, then the table's room.
 */
function diagnoseSeat(
  db: Db,
  input: { weddingId: string; eventId: string; guestId: string; tableId: string },
): Effect.Effect<
  never,
  | SeatingEventNotFound
  | SeatingTableNotFound
  | SeatingGuestNotFound
  | SeatingHouseholdWithdrawn
  | SeatingTableFull
> {
  return Effect.gen(function* () {
    const [eventRows, tableRows, guestRows] = (yield* dbQuery(() =>
      commitBatchResults(db, [
        eventOfWedding(db, input.weddingId, input.eventId),
        db
          .select({ id: seatingTables.id })
          .from(seatingTables)
          .where(
            and(
              eq(seatingTables.id, input.tableId),
              eq(seatingTables.eventId, input.eventId),
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
              eq(guestEvents.eventId, input.eventId),
              eq(families.weddingId, input.weddingId),
            ),
          ),
      ]),
    )) as [unknown[], unknown[], Array<{ kind: string; deactivatedAt: unknown }>];
    if (eventRows.length === 0) return yield* Effect.fail(new SeatingEventNotFound());
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

export const seatingService = {
  /** One event's chart: the event, its tables in order, and every guest it holds. */
  chart(
    weddingId: string,
    eventId: string,
  ): Effect.Effect<SeatingChartDto, SeatingEventNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [eventRows, tableRows, guestRows] = (yield* dbQuery(() =>
        commitBatchResults(db, [
          db
            .select({
              id: events.id,
              name: events.name,
            })
            .from(events)
            .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId))),
          db
            .select(tableColumns)
            .from(seatingTables)
            .where(and(eq(seatingTables.eventId, eventId), eq(seatingTables.weddingId, weddingId)))
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
                eq(seatingAssignments.eventId, guestEvents.eventId),
                eq(seatingAssignments.guestId, guestEvents.guestId),
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
        TableRow[],
        Array<Omit<SeatingGuestDto, "withdrawn"> & { deactivatedAt: unknown }>,
      ];
      const event = eventRows[0];
      if (!event) return yield* Effect.fail(new SeatingEventNotFound());
      if (guestRows.length > MAX_CHART_GUESTS) {
        yield* Effect.logWarning("seating chart read past its guest ceiling").pipe(
          Effect.annotateLogs({ weddingId, eventId, ceiling: MAX_CHART_GUESTS }),
        );
      }
      return {
        event,
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

  /** Add a table at the end of the event's order. */
  createTable(input: {
    weddingId: string;
    eventId: string;
    name: string;
    capacity: number;
  }): Effect.Effect<SeatingTableDto, SeatingEventNotFound | SeatingTableLimit, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const id = `stb_${crypto.randomUUID()}`;
      const now = new Date();
      const peers = alias(seatingTables, "seat_peers");
      // One statement: the event must be this wedding's, and the event must
      // have room for another table — both read where the row is written.
      const [created] = (yield* dbQuery(() =>
        db
          .insert(seatingTables)
          .select(
            // Every `seating_tables` column, in the table's order.
            db
              .select({
                id: bound(id, seatingTables.id),
                weddingId: events.weddingId,
                eventId: events.id,
                name: bound(input.name, seatingTables.name),
                capacity: bound(input.capacity, seatingTables.capacity),
                sortOrder: sql`coalesce(${db
                  .select({ last: max(peers.sortOrder) })
                  .from(peers)
                  .where(eq(peers.eventId, input.eventId))}, -1) + 1`.as("sort_order"),
                createdAt: bound(now, seatingTables.createdAt),
                updatedAt: bound(now, seatingTables.updatedAt),
              })
              .from(events)
              .where(
                and(
                  eq(events.id, input.eventId),
                  eq(events.weddingId, input.weddingId),
                  sql`${db
                    .select({ n: count() })
                    .from(peers)
                    .where(eq(peers.eventId, input.eventId))} < ${MAX_TABLES_PER_EVENT}`,
                ),
              ),
          )
          .returning(tableColumns)
          .all(),
      )) as TableRow[];
      if (created) {
        metricSeatingTableWrite("create");
        return created;
      }
      const [event] = yield* dbQuery(() =>
        eventOfWedding(db, input.weddingId, input.eventId).all(),
      );
      if (!event) return yield* Effect.fail(new SeatingEventNotFound());
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

  /** Delete a table. Its guests become unseated: their seats cascade with it. */
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
   * Give the event's tables the order of `orderedIds`. One statement, so the
   * order lands whole or not at all: each table reads its new place from one
   * bound JSON object keyed by id, and only a table whose place changed is
   * written, so a keyboard step writes the two tables it swaps. An id that is
   * not a table at this event of this wedding matches no row. Ids are word
   * characters and hyphens (the schema refuses anything else), which is what
   * makes them safe inside a JSON path.
   */
  reorderTables(
    weddingId: string,
    eventId: string,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      if (orderedIds.length === 0) return;
      const places = JSON.stringify(
        Object.fromEntries(orderedIds.map((id, place) => [id, place] as const)),
      );
      const path = sql`'$."' || ${outerColumn(seatingTables.id)} || '"'`;
      const place = sql`json_extract(${places}, ${path})`;
      yield* dbQuery(() =>
        db
          .update(seatingTables)
          .set({ sortOrder: place, updatedAt: new Date() })
          .where(
            and(
              eq(seatingTables.eventId, eventId),
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
   * Put a guest at a table, move them to another, or (with `tableId: null`)
   * clear their seat at the event.
   *
   * A seat or a move is one batch — one transaction on D1 — of three
   * statements: a conditional UPDATE that moves an existing seat, a
   * conditional INSERT that seats a guest with none, and the seat after. Each write carries every rule in its own WHERE (the table is this
   * event's, it has room, the household is active), so a refused move changes
   * nothing and the guest keeps the seat they had. Only the refusal path reads
   * again, to say why.
   */
  seat(input: {
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

      if (tableId === null) {
        const [eventRows, removed] = (yield* dbQuery(() =>
          commitBatchResults(db, [
            eventOfWedding(db, weddingId, eventId),
            db
              .delete(seatingAssignments)
              .where(
                and(
                  eq(seatingAssignments.eventId, eventId),
                  eq(seatingAssignments.guestId, guestId),
                  inArray(seatingAssignments.eventId, eventOfWedding(db, weddingId, eventId)),
                ),
              )
              .returning({ tableId: seatingAssignments.tableId }),
          ]),
        )) as [unknown[], Array<{ tableId: string }>];
        if (eventRows.length === 0) return yield* Effect.fail(new SeatingEventNotFound());
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
                eq(seatingAssignments.eventId, eventId),
                eq(seatingAssignments.guestId, guestId),
                ne(seatingAssignments.tableId, tableId),
                tableAtEvent(db, weddingId, eventId, tableId),
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
                  eventId: guestEvents.eventId,
                  guestId: guestEvents.guestId,
                  createdAt: bound(now, seatingAssignments.createdAt),
                })
                .from(guestEvents)
                .where(
                  and(
                    eq(guestEvents.guestId, guestId),
                    eq(guestEvents.eventId, eventId),
                    activeGuestOfWedding(db, weddingId, guestId),
                    tableAtEvent(db, weddingId, eventId, tableId),
                    roomAt(db, tableId),
                    notExists(
                      db
                        .select({ one: sql`1` })
                        .from(existing)
                        .where(and(eq(existing.eventId, eventId), eq(existing.guestId, guestId))),
                    ),
                  ),
                ),
            )
            .onConflictDoNothing()
            .returning({ tableId: seatingAssignments.tableId }),
          seatOf(db, weddingId, eventId, guestId),
        ]),
      );
      // The writes say what they did, inside the same transaction: a moved
      // seat comes back from the UPDATE, a new one from the INSERT, and a seat
      // already at this table from neither.
      const moved = (results[0] as unknown[]).length > 0;
      const seated = (results[1] as unknown[]).length > 0;
      const after = (results[2] as Array<{ tableId: string }>)[0]?.tableId ?? null;
      if (after !== tableId) {
        return yield* diagnoseSeat(db, { weddingId, eventId, guestId, tableId });
      }
      if (seated) metricSeatingSeatWrite("seat");
      else if (moved) metricSeatingSeatWrite("move");
      return { guestId, tableId };
    }).pipe(Effect.withSpan("cire.seating.seat"));
  },
};

/** What a guest-list change would take off the seating chart. */
export interface SeatingLoss {
  seats: number;
  tables: number;
}

/**
 * How many seats and tables a change to the guest list or the schedule would
 * remove: the seats of removed guests, of removed (guest, event) invitations
 * and of removed events, and the removed events' tables. One statement, only
 * when the change removes one of the three. Every list rides as one bound
 * `json_each` parameter, so a change of any size stays inside D1's
 * 100-parameter limit; a pair is `guest_id` and `event_id` joined by the unit
 * separator, which no id contains.
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
      return { seats: 0, tables: 0 };
    }
    const db = yield* DbService;
    const pairs = removed.links.map((link) => `${link.guestId}\u001f${link.eventId}`);
    const [counts] = yield* dbQuery(() =>
      db
        .select({
          seats: db.$count(
            seatingAssignments,
            and(
              // Through the wedding's events, whose ids lead the seats'
              // unique index.
              inArray(
                seatingAssignments.eventId,
                db.select({ id: events.id }).from(events).where(eq(events.weddingId, weddingId)),
              ),
              or(
                inArray(seatingAssignments.guestId, jsonEachIn(removed.guestIds)),
                inArray(seatingAssignments.eventId, jsonEachIn(removed.eventIds)),
                inArray(
                  sql`${seatingAssignments.guestId} || char(31) || ${seatingAssignments.eventId}`,
                  jsonEachIn(pairs),
                ),
              ),
            ),
          ),
          tables: db.$count(
            seatingTables,
            and(
              inArray(seatingTables.eventId, jsonEachIn(removed.eventIds)),
              eq(seatingTables.weddingId, weddingId),
            ),
          ),
        })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    return { seats: Number(counts?.seats ?? 0), tables: Number(counts?.tables ?? 0) };
  }).pipe(Effect.withSpan("cire.seating.loss"));
}

/** The preview's warning for a change that takes seats or tables off the
 *  chart, or `null` when it takes neither. A revert restores guests and events
 *  from a before-image that holds no seating, so the loss is final. */
export function seatingLossWarning(loss: SeatingLoss): string | null {
  const parts: string[] = [];
  if (loss.seats > 0) parts.push(`clears ${loss.seats} ${loss.seats === 1 ? "seat" : "seats"}`);
  if (loss.tables > 0) {
    parts.push(`removes ${loss.tables} ${loss.tables === 1 ? "table" : "tables"}`);
  }
  if (parts.length === 0) return null;
  return `This change ${parts.join(" and ")} from the seating chart. Reverting it does not bring them back.`;
}
