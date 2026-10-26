import type { Database } from "bun:sqlite";

import type { D1Database, D1DatabaseSession, D1PreparedStatement } from "@cloudflare/workers-types";

/**
 * A member of the D1 binding type that no Effect path calls yet. It throws
 * when reached, so a later stage that starts to use one fails at that call
 * instead of answering wrongly.
 */
const notYetUsed = (member: string): never => {
  throw new Error(`local D1 binding: ${member} is not implemented; no Effect path calls it yet`);
};

/**
 * A D1 binding over a bun:sqlite connection, for local dev and the test suite.
 *
 * It answers the calls the Effect handle makes in arrays mode (`prepare`,
 * `bind`, `raw`) and the session calls the request shim makes (`withSession`,
 * the session's `prepare`). Every other member of the D1 type throws. Local
 * dev and tests therefore run the same driver path as a Worker, over the same
 * connection as the promise fixtures.
 */
export function localD1Binding(sqlite: Database): D1Database {
  const statement = (query: string, params: unknown[]): D1PreparedStatement => ({
    bind: (...values: unknown[]) => statement(query, values),
    first: () => notYetUsed("first"),
    run: () => notYetUsed("run"),
    all: () => notYetUsed("all"),
    raw: rawArrays(sqlite, query, params),
  });

  const prepare = (query: string) => statement(query, []);

  const session: D1DatabaseSession = {
    prepare,
    batch: () => notYetUsed("batch"),
    getBookmark: () => null,
  };

  return {
    prepare,
    batch: () => notYetUsed("batch"),
    exec: () => notYetUsed("exec"),
    withSession: () => session,
    dump: () => notYetUsed("dump"),
  };
}

/**
 * `raw` for a statement: rows as arrays of column values, or, with
 * `columnNames: true`, the column names followed by those rows. Overloaded
 * because the D1 type is.
 */
const rawArrays = (
  sqlite: Database,
  query: string,
  params: unknown[],
): D1PreparedStatement["raw"] => {
  const impl = async (options?: { columnNames?: boolean }): Promise<unknown[]> => {
    const stmt = sqlite.query(query);
    const rows = stmt.values(...(params as never[]));
    return options?.columnNames ? [stmt.columnNames, ...rows] : rows;
  };
  // Safety: `impl` returns the array shapes the two overloads describe; the
  // overloads cannot be written as one generic arrow.
  return impl as D1PreparedStatement["raw"];
};
