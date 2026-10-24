import { SqliteClient } from "@effect/sql-sqlite-bun";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-bun";
import { type Context, Effect, Layer } from "effect";

/** The drizzle handle the bun:sqlite layer provides. */
export type EffectSqliteDb = Effect.Success<ReturnType<typeof makeWithDefaults>>;

/**
 * An Effect-native drizzle handle over a bun:sqlite file (or `:memory:`), provided
 * as the service of `tag`. `foreign_keys` is on, as in the promise path
 * (`createDrizzleClient`). The journal mode is left as SQLite has it: WAL is off.
 *
 * This module imports `bun:sqlite` statically, so import it only from Bun code
 * (dev servers, tests). Workers import `./d1`.
 */
export function makeEffectSqliteLayer<I>(
  tag: Context.Service<I, EffectSqliteDb>,
  filename: string,
) {
  const client = SqliteClient.layer({ filename, disableWAL: true });
  const database = Layer.effect(
    tag,
    Effect.gen(function* () {
      const db = yield* makeWithDefaults({});
      const sqlClient = yield* SqliteClient.SqliteClient;
      yield* sqlClient`PRAGMA foreign_keys = ON`;
      return db;
    }),
  );
  return database.pipe(Layer.provideMerge(client));
}

/**
 * Rows changed by the most recent write on this connection. bun:sqlite returns a
 * write's result as a row array, which carries no count, so `rowsChanged` reads
 * 0 for it. Read this straight after the write, on the same layer.
 */
export const changesAfterWrite = Effect.flatMap(SqliteClient.SqliteClient, (sqlClient) =>
  sqlClient<{ n: number }>`select changes() as n`.pipe(Effect.map((rows) => rows[0]?.n ?? 0)),
);
