import { runOfShowItems } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "../db";
import type { RunOfShowItem } from "../schemas/import";

// An event's run of show: how a read of `events` carries it, and the
// statements an apply writes it with. The rows live in `run_of_show_items`
// ([[cire-guest-event-editor]] §3.3), one per item, keyed by
// `(event_id, sort_order)`; every write replaces an event's whole list.

/**
 * The event's run of show as one column of an `events` read: a JSON array of
 * `[sort_order, time, label]` tuples, found through the items' primary key.
 * The aggregate's order is not guaranteed, so {@link runOfShowFrom} sorts by
 * `sort_order`. Written with explicit table names: drizzle
 * prints a column in a selected `sql` field without its table, and both tables
 * have a `sort_order`.
 */
export const runOfShowColumn: SQL<string> = sql<string>`(SELECT json_group_array(json_array(${sql.identifier("run_of_show_items")}.${sql.identifier("sort_order")}, ${sql.identifier("run_of_show_items")}.${sql.identifier("time")}, ${sql.identifier("run_of_show_items")}.${sql.identifier("label")})) FROM ${sql.identifier("run_of_show_items")} WHERE ${sql.identifier("run_of_show_items")}.${sql.identifier("event_id")} = ${sql.identifier("events")}.${sql.identifier("id")})`;

/** A {@link runOfShowColumn} value as the event's list, in the organiser's order. */
export function runOfShowFrom(json: string | null | undefined): RunOfShowItem[] {
  if (!json) return [];
  const tuples = JSON.parse(json) as [number, string, string][];
  return tuples.toSorted((a, b) => a[0] - b[0]).map(([, time, label]) => ({ time, label }));
}

/** The column each position of an item's JSON tuple fills. */
const TUPLE_FIELDS = ["eventId", "weddingId", "sortOrder", "time", "label"] as const;

/**
 * The most bytes of item JSON one insert carries. D1 caps an SQL statement at
 * 100,000 bytes (https://developers.cloudflare.com/d1/platform/limits/) and
 * does not say whether a bound value counts toward it, so each payload is held
 * under that size. A full list of 40 items of 200 characters is tens of
 * kilobytes at most, so one statement usually carries every list a save writes.
 */
export const RUN_OF_SHOW_INSERT_BYTES = 100_000;

const utf8 = new TextEncoder();

/**
 * The statements that make each given event's run of show the given list, for
 * an apply's write set: one delete of every replaced event's old items, then
 * `INSERT … SELECT … FROM json_each(?)` statements carrying every list's items
 * as one JSON parameter each, as few as the byte budget allows. A list of 40
 * items is 200 values, over D1's 100 bound parameters as a multi-row insert;
 * as one JSON parameter it is one statement. Builders, not `db.run`, so they
 * run when the batch does on both drivers.
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
  // Drizzle inserts every column in schema order, so the select list is
  // derived from that order.
  const selectList = Object.keys(getTableColumns(runOfShowItems)).map((key): SQL => {
    const position = (TUPLE_FIELDS as readonly string[]).indexOf(key);
    if (position < 0) throw new Error(`run_of_show_items column "${key}" has no tuple position`);
    return sql`json_extract(value, ${`$[${position}]`})`;
  });
  const insert = (tuples: readonly string[]) =>
    statements.push(
      db
        .insert(runOfShowItems)
        .select(
          sql`SELECT ${sql.join(selectList, sql`, `)} FROM json_each(${`[${tuples.join(",")}]`})`,
        ),
    );

  // Each tuple as JSON, packed into payloads under the byte budget.
  let chunk: string[] = [];
  let bytes = 2;
  for (const { eventId, items } of lists) {
    for (const [sortOrder, item] of items.entries()) {
      const tuple = JSON.stringify([eventId, weddingId, sortOrder, item.time, item.label]);
      const size = utf8.encode(tuple).length + 1;
      if (chunk.length > 0 && bytes + size > RUN_OF_SHOW_INSERT_BYTES) {
        insert(chunk);
        chunk = [];
        bytes = 2;
      }
      chunk.push(tuple);
      bytes += size;
    }
  }
  if (chunk.length > 0) insert(chunk);
  return statements;
}
