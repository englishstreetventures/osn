import { Database } from "bun:sqlite";

import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Context, Effect, Exit, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { commitEffectWrites } from "../../src/effect/batch";
import { makeEffectD1Layer, type D1QueryClient, type EffectD1Db } from "../../src/effect/d1";

class D1Db extends Context.Service<D1Db, EffectD1Db>()("D1Db") {}

const users = sqliteTable("users", { id: text("id").primaryKey() });

// A D1 binding over bun:sqlite. batch runs its statements in one transaction and
// rolls back on the first failure, as D1 does.
function fakeD1(db: Database): D1QueryClient {
  const run = (query: string, params: unknown[]) => db.query(query).all(...(params as never[]));
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            query,
            params,
            all: async () => ({ results: run(query, params), success: true, meta: {} }),
            raw: async () => db.query(query).values(...(params as never[])),
          };
        },
      };
    },
    batch: async (statements: ReadonlyArray<{ query: string; params: unknown[] }>) => {
      db.exec("begin");
      try {
        const out = statements.map((s) => ({
          results: run(s.query, s.params),
          success: true,
          meta: {},
        }));
        db.exec("commit");
        return out;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
  } as unknown as D1QueryClient;
}

describe("commitEffectWrites", () => {
  // The batch is one transaction, so a failed write leaves no earlier write behind.
  it("a failed write leaves no earlier write behind on D1", async () => {
    const memory = new Database(":memory:");
    const rt = ManagedRuntime.make(makeEffectD1Layer(D1Db, fakeD1(memory)));
    await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* D1Db;
        yield* db.run(sql`create table users (id text primary key)`);
      }),
    );
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* D1Db;
        yield* commitEffectWrites(db, [
          db.insert(users).values({ id: "a" }),
          db.insert(users).values({ id: "a" }),
        ]);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(memory.query("select count(*) as n from users").get()).toEqual({ n: 0 });
    await rt.dispose();
  });

  it("commits every write on D1 when all succeed", async () => {
    const memory = new Database(":memory:");
    const rt = ManagedRuntime.make(makeEffectD1Layer(D1Db, fakeD1(memory)));
    await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* D1Db;
        yield* db.run(sql`create table users (id text primary key)`);
        yield* commitEffectWrites(db, [
          db.insert(users).values({ id: "a" }),
          db.insert(users).values({ id: "b" }),
        ]);
      }),
    );
    expect(memory.query("select id from users order by id").all()).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    await rt.dispose();
  });
});
