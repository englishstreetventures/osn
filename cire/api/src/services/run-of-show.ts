import { events, runOfShowItems } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { DbService, dbQuery, type Db } from "../db";
import type { RunOfShowItem } from "../schemas/import";

// An event's run of show: reads, and the statements an apply writes it with.
// The rows live in `run_of_show_items` ([[cire-guest-event-editor]] §3.3), one
// per item, keyed by `(event_id, sort_order)`; every write replaces an event's
// whole list.

/** One stored item with the event it belongs to. */
export interface StoredRunOfShowItem extends RunOfShowItem {
  readonly eventId: string;
}

/**
 * Every item of every event of a wedding, by event and then the organiser's
 * order. Reached through the wedding's events, whose `(wedding_id, sort_order)`
 * index is searched, then the items' primary key: no index on the items leads
 * with `wedding_id`, so filtering on that column would scan every wedding's.
 */
export function storedRunsOfShow(
  weddingId: string,
): Effect.Effect<StoredRunOfShowItem[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    return yield* dbQuery(() =>
      db
        .select({
          eventId: runOfShowItems.eventId,
          time: runOfShowItems.time,
          label: runOfShowItems.label,
        })
        .from(runOfShowItems)
        .where(
          inArray(
            runOfShowItems.eventId,
            db.select({ id: events.id }).from(events).where(eq(events.weddingId, weddingId)),
          ),
        )
        .orderBy(asc(runOfShowItems.eventId), asc(runOfShowItems.sortOrder))
        .all(),
    );
  }).pipe(Effect.withSpan("cire.run-of-show.forWedding"));
}

/**
 * The items of the given events, by event and then the organiser's order. The
 * ids ride as one JSON parameter, so any number stays one statement under
 * D1's bound-parameter cap. The caller has already scoped the ids to a wedding.
 */
export function runsOfShowFor(
  eventIds: readonly string[],
): Effect.Effect<StoredRunOfShowItem[], never, DbService> {
  if (eventIds.length === 0) return Effect.succeed([]);
  return Effect.gen(function* () {
    const db = yield* DbService;
    return yield* dbQuery(() =>
      db
        .select({
          eventId: runOfShowItems.eventId,
          time: runOfShowItems.time,
          label: runOfShowItems.label,
        })
        .from(runOfShowItems)
        .where(inArray(runOfShowItems.eventId, jsonEachIn([...eventIds])))
        .orderBy(asc(runOfShowItems.eventId), asc(runOfShowItems.sortOrder))
        .all(),
    );
  }).pipe(Effect.withSpan("cire.run-of-show.forEvents"));
}

/** Stored items grouped into each event's list, in the order they were read. */
export function byEvent(rows: readonly StoredRunOfShowItem[]): Map<string, RunOfShowItem[]> {
  const lists = new Map<string, RunOfShowItem[]>();
  for (const { eventId, time, label } of rows) {
    const list = lists.get(eventId);
    if (list) list.push({ time, label });
    else lists.set(eventId, [{ time, label }]);
  }
  return lists;
}

/** The column each position of an item's JSON tuple fills. */
const TUPLE_FIELDS = ["eventId", "weddingId", "sortOrder", "time", "label"] as const;

/**
 * The statements that make each given event's run of show the given list, for
 * an apply's write set: one delete of every listed event's old items, then one
 * `INSERT … SELECT … FROM json_each(?)` per event with items. One event's list
 * of 40 items is 200 values, over D1's 100 bound parameters as a multi-row
 * insert; as one JSON parameter it is one statement. Builders, not `db.run`,
 * so they run when the batch does on both drivers.
 *
 * `replaced` lists events whose items already exist and are being replaced
 * (an update); a new event has none to delete. Every event id comes from a
 * plan built from this wedding's reads, and the delete is held to the wedding
 * besides.
 */
export function runOfShowStatements(
  db: Db,
  weddingId: string,
  lists: readonly { readonly eventId: string; readonly items: readonly RunOfShowItem[] }[],
  replaced: readonly string[],
): BatchItem<"sqlite">[] {
  const statements: BatchItem<"sqlite">[] = [];
  if (replaced.length > 0) {
    statements.push(
      db
        .delete(runOfShowItems)
        .where(
          and(
            eq(runOfShowItems.weddingId, weddingId),
            inArray(runOfShowItems.eventId, jsonEachIn([...replaced])),
          ),
        ),
    );
  }
  for (const { eventId, items } of lists) {
    if (items.length === 0) continue;
    const payload = JSON.stringify(
      items.map((item, sortOrder) => [eventId, weddingId, sortOrder, item.time, item.label]),
    );
    // Drizzle inserts every column in schema order, so the select list is
    // derived from that order.
    const selectList = Object.keys(getTableColumns(runOfShowItems)).map((key): SQL => {
      const position = (TUPLE_FIELDS as readonly string[]).indexOf(key);
      if (position < 0) throw new Error(`run_of_show_items column "${key}" has no tuple position`);
      return sql`json_extract(value, ${`$[${position}]`})`;
    });
    statements.push(
      db
        .insert(runOfShowItems)
        .select(sql`SELECT ${sql.join(selectList, sql`, `)} FROM json_each(${payload})`),
    );
  }
  return statements;
}
