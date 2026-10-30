import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * `value` as a bound parameter, encoded by `column` as `.values()` would encode
 * it (a timestamp column stores seconds) and named for the column — for the
 * select list of an `INSERT … SELECT`, whose keys must each be a column of the
 * table written to.
 */
export const bound = <T>(value: T, column: AnySQLiteColumn) =>
  sql<T>`${sql.param(value, column)}`.as(column.name);
