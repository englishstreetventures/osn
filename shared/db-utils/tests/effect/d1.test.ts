import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Cause, Context, Effect, Exit, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { makeEffectD1Layer, type D1QueryClient, type EffectD1Db } from "../../src/effect/d1";
import { driverErrorText, rowsChanged } from "../../src/index";

class TestD1Db extends Context.Service<TestD1Db, EffectD1Db>()("TestD1Db") {}

// A D1 binding over bun:sqlite, answering the calls @effect/sql-d1 makes:
// prepare, then bind, then all or raw. These tests make no batch.
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
      throw new Error("batch is not used by these tests");
    },
  };
  return binding;
}

function runtimeOver(binding: ReturnType<typeof fakeD1>) {
  return ManagedRuntime.make(makeEffectD1Layer(TestD1Db, binding as unknown as D1QueryClient));
}

describe("effect D1 layer", () => {
  // the production config turns the prepare cache off. A cached read would reuse a statement prepared under an earlier session.
  it("prepares a statement again for every read", async () => {
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

  // on D1 the write result carries meta.changes, and rowsChanged must read it.
  it("rowsChanged reads the true count from a D1 write result", async () => {
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

  // @effect/sql-d1 has no transactions and dies on the first one.
  it("a transaction on the D1 layer dies rather than succeeding", async () => {
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

  // Drizzle's EffectLogger layer writes bound params as annotations, so nothing here may use it.
  it("does not use drizzle's EffectLogger layer", () => {
    for (const file of ["d1.ts", "batch.ts"]) {
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../src/effect", file),
        "utf8",
      );
      expect(src).not.toContain("EffectLogger.layer");
    }
  });

  // The layer is built once per runtime, so every effect sees one handle.
  it("builds the handle once per runtime", async () => {
    const rt = runtimeOver(fakeD1(new Database(":memory:")));
    const grab = Effect.gen(function* () {
      return yield* TestD1Db;
    });
    const [a, b] = await Promise.all([rt.runPromise(grab), rt.runPromise(grab)]);
    expect(a).toBe(b);
    await rt.dispose();
  });

  // A failed write must not render its bound value in any form a log or response can read.
  it("keeps a bound value out of the failed-query renderings", async () => {
    const NAME = "Annabelle Quigley-Smythe";
    const rt = runtimeOver(fakeD1(new Database(":memory:")));
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* TestD1Db;
        yield* db.run(sql`create table g (name text not null check (name = 'never'))`);
        yield* db.run(sql`insert into g (name) values (${NAME})`);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const cause = Exit.isFailure(exit) ? exit.cause : undefined;
    expect(Cause.pretty(cause!)).not.toContain(NAME);
    expect(String(cause)).not.toContain(NAME);
    expect(JSON.stringify(cause)).not.toContain(NAME);
    await rt.dispose();
  });

  // A UNIQUE violation reaches the caller as an Effect Cause; driverErrorText must still find the reason.
  it("lets driverErrorText find the database reason inside an Effect Cause", async () => {
    const rt = runtimeOver(fakeD1(new Database(":memory:")));
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* TestD1Db;
        yield* db.run(sql`create table u (name text unique)`);
        yield* db.run(sql`insert into u (name) values ('ann')`);
        yield* db.run(sql`insert into u (name) values ('ann')`);
      }),
    );
    const reason = Exit.isFailure(exit) ? driverErrorText(exit.cause) : "";
    expect(reason).toContain("UNIQUE constraint failed");
    await rt.dispose();
  });
});
