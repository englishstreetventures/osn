import { D1Client } from "@effect/sql-d1";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** A drizzle write that can render itself as SQL and parameters, such as `db.insert(t).values(v)`. */
export interface WriteStatement {
  toSQL(): { sql: string; params: unknown[] };
}

/** The part of an Effect drizzle handle this module reads: its SQL client. */
export interface EffectWriteDb {
  readonly $client: SqlClient.SqlClient;
}

/**
 * True when the client is a D1 client. Read from the client itself, so the
 * decision needs no service in context and no `bun:sqlite` import.
 */
const isD1Client = (client: SqlClient.SqlClient): client is D1Client.D1Client =>
  D1Client.TypeId in client;

/**
 * Commit a write set atomically on D1.
 *
 * D1 has no interactive transactions, so the writes go out as one
 * `D1Client.batch`, which is a transaction. The client is read from
 * `db.$client`, so a caller that holds only the handle needs no service in
 * context. Any other client is a defect: nothing in the repository builds one.
 *
 * The writes run in the order given; list a parent before its children.
 */
export const commitEffectWrites = (db: EffectWriteDb, writes: ReadonlyArray<WriteStatement>) =>
  Effect.gen(function* () {
    if (writes.length === 0) return;
    const client = db.$client;
    const statements = writes.map((write) => {
      const { sql, params } = write.toSQL();
      return client.unsafe(sql, params);
    });
    if (!isD1Client(client)) {
      return yield* Effect.die(new Error("commitEffectWrites needs a D1 client"));
    }
    yield* client.batch(statements);
  });
