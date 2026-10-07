import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * A column's position in a code-defined display order, as an SQL expression to
 * ORDER BY: `keys[0]` is 0, `keys[1]` is 1, and any value not in `keys` sorts
 * after all of them. For a stored key whose text order is not the order the
 * portal shows (`"12m" < "1m" < "6m"`, `"catering" < "venue"`), so that a read
 * can be ordered, and cut with LIMIT, in the database.
 *
 * Every key is a bound parameter. D1 allows 100 per statement, so a list of
 * more than about forty keys belongs in a table, not here.
 */
export function displayRank(column: AnyColumn, keys: readonly string[]): SQL<number> {
  const whens = keys.map((key, index) => sql`WHEN ${key} THEN ${index}`);
  return sql<number>`CASE ${column} ${sql.join(whens, sql` `)} ELSE ${keys.length} END`;
}
