import { Database } from "bun:sqlite";

import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Context, Effect, Exit, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { makeEffectD1Layer, type D1QueryClient, type EffectD1Db } from "../../src/effect/d1";
import { rowsChanged } from "../../src/index";

class TestD1Db extends Context.Service<TestD1Db, EffectD1Db>()("TestD1Db") {}

// A D1 binding over bun:sqlite, answering the calls @effect/sql-d1 makes:
// prepare, then bind, then all or raw. batch is not used in PR 1.
function fakeD1(db: Database) {
  let prepares = 0;
  const binding = {
    prepares: () => prepares,
    prepare(query: string) {
      prepares++;
      const stmt = db.query(query);
      return {
        bind(...params: unknown[]) {
          return {
            all: async () => {
              const results = stmt.all(...(params as never[]));
              const changes = (db.query("select changes() as n").get() as { n: number }).n;
              return { results, success: true, meta: { changes } };
            },
            raw: async () => stmt.values(...(params as never[])),
          };
        },
      };
    },
    batch: async () => {
      throw new Error("batch is not used in PR 1");
    },
  };
  return binding;
}

function runtimeOver(binding: ReturnType<typeof fakeD1>) {
  return ManagedRuntime.make(makeEffectD1Layer(TestD1Db, binding as unknown as D1QueryClient));
}

describe("effect D1 layer", () => {
  // F2: the production config turns the prepare cache off. A cached read would reuse a statement prepared under an earlier session.
  it("F2: prepares a statement again for every read", async () => {
    const binding = fakeD1(new Database(":memory:"));
    const rt = runtimeOver(binding);
    await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* TestD1Db;
        yield* db.run(sql`create table g (id text primary key)`);
      }),
    );
    const before = binding.prepares();
    await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* TestD1Db;
        yield* db.all(sql`select id from g`);
        yield* db.all(sql`select id from g`);
      }),
    );
    expect(binding.prepares() - before).toBe(2);
    await rt.dispose();
  });

  // F4: on D1 the write result carries meta.changes, and rowsChanged must read it.
  it("F4: rowsChanged reads the true count from a D1 write result", async () => {
    const t = sqliteTable("t", { id: text("id").primaryKey(), v: text("v") });
    const binding = fakeD1(new Database(":memory:"));
    const rt = runtimeOver(binding);
    const changed = await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* TestD1Db;
        yield* db.run(sql`create table t (id text primary key, v text)`);
        yield* db.run(sql`insert into t (id, v) values ('a', 'x'), ('b', 'x')`);
        const result = yield* db.update(t).set({ v: "y" }).run();
        return rowsChanged(result);
      }),
    );
    expect(changed).toBe(2);
    await rt.dispose();
  });

  // T1: @effect/sql-d1 has no transactions and dies on the first one.
  it("T1: a transaction on the D1 layer dies rather than succeeding", async () => {
    const binding = fakeD1(new Database(":memory:"));
    const rt = runtimeOver(binding);
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* TestD1Db;
        yield* db.transaction(() => Effect.succeed(1));
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    await rt.dispose();
  });
});
