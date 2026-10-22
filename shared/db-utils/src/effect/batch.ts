import { D1Client } from "@effect/sql-d1";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";

/** A drizzle write that can render itself as SQL and parameters, such as `db.insert(t).values(v)`. */
export interface WriteStatement {
  toSQL(): { sql: string; params: unknown[] };
}

/**
 * Commit a write set atomically on whichever driver the environment provides.
 *
 * D1 has no interactive transactions, so on D1 the writes go out as one
 * `D1Client.batch`, which is a transaction. On bun:sqlite the same writes run
 * inside `withTransaction`. Detection is by the `D1Client` service, so this
 * module never imports `bun:sqlite` and is safe in a Workers bundle.
 *
 * The writes run in the order given; list a parent before its children.
 */
export const commitEffectWrites = (writes: ReadonlyArray<WriteStatement>) =>
  Effect.gen(function* () {
    if (writes.length === 0) return;
    const client = yield* SqlClient.SqlClient;
    const statements = writes.map((write) => {
      const { sql, params } = write.toSQL();
      return client.unsafe(sql, params);
    });
    const d1 = yield* Effect.serviceOption(D1Client.D1Client);
    if (Option.isSome(d1)) {
      yield* d1.value.batch(statements);
      return;
    }
    yield* client.withTransaction(
      Effect.forEach(statements, (statement) => statement, { discard: true }),
    );
  });
