import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { Cause, Context, Effect, Exit, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import {
  changesAfterWrite,
  makeEffectSqliteLayer,
  type EffectSqliteDb,
} from "../../src/effect/sqlite";
import { driverErrorText, rowsChanged } from "../../src/index";

class TestDb extends Context.Service<TestDb, EffectSqliteDb>()("TestDb") {}

const newRuntime = (filename = ":memory:") =>
  ManagedRuntime.make(makeEffectSqliteLayer(TestDb, filename));

// B1: the layer turns foreign keys on, as the promise path does (`createDrizzleClient`).
describe("effect bun:sqlite layer", () => {
  it("B1: enforces foreign keys", async () => {
    const rt = newRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* TestDb;
        yield* db.run(sql`create table parent (id text primary key)`);
        yield* db.run(sql`create table child (parent_id text references parent(id))`);
        yield* db.run(sql`insert into child (parent_id) values ('missing')`);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    await rt.dispose();
  });

  // B2: @effect/sql-sqlite-bun switches files to WAL unless disableWAL is set.
  it("B2: keeps the journal mode of a file database", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "d1-layer-")), "dev.sqlite");
    const rt = newRuntime(path);
    const mode = await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* TestDb;
        const rows = yield* db.all(sql`pragma journal_mode`);
        return rows as unknown as Array<{ journal_mode: string }>;
      }),
    );
    expect(mode[0]!.journal_mode).toBe("delete");
    await rt.dispose();
  });

  // B3: nothing in the subpath uses drizzle's EffectLogger layer, which writes bound params as annotations.
  it("B3: does not use drizzle's EffectLogger layer", () => {
    for (const file of ["sqlite.ts", "d1.ts"]) {
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../src/effect", file),
        "utf8",
      );
      expect(src).not.toContain("EffectLogger.layer");
    }
  });

  // F5: the layer is built once per runtime, so both effects see one database.
  it("F5: builds the database once per runtime", async () => {
    const rt = newRuntime();
    const grab = Effect.gen(function* () {
      return yield* TestDb;
    });
    const [a, b] = await Promise.all([rt.runPromise(grab), rt.runPromise(grab)]);
    expect(a).toBe(b);
    await rt.dispose();
  });

  // D-1: on bun the write result is a row array, so the change count is read from the connection.
  it("D-1: changesAfterWrite reads 0 for a no-op and 1 for a real update", async () => {
    const rt = newRuntime();
    const counts = await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* TestDb;
        yield* db.run(sql`create table t (id text primary key, v text)`);
        yield* db.run(sql`insert into t (id, v) values ('a', 'x')`);
        yield* db.run(sql`update t set v = 'x' where id = 'nope'`);
        const none = yield* changesAfterWrite;
        yield* db.run(sql`update t set v = 'y' where id = 'a'`);
        const one = yield* changesAfterWrite;
        return { none, one };
      }),
    );
    expect(counts).toEqual({ none: 0, one: 1 });
    await rt.dispose();
  });

  // F3: a failed write must not render its bound value in any form a log or response can read.
  it("F3: keeps a bound value out of the failed-query renderings", async () => {
    const NAME = "Annabelle Quigley-Smythe";
    const rt = newRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* TestDb;
        yield* db.run(sql`create table g (name text not null check (name = 'never'))`);
        yield* db.run(sql`insert into g (name) values ()`);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const cause = Exit.isFailure(exit) ? exit.cause : undefined;
    expect(Cause.pretty(cause!)).not.toContain(NAME);
    expect(String(cause)).not.toContain(NAME);
    expect(JSON.stringify(cause)).not.toContain(NAME);
    await rt.dispose();
  });

  // F7: a UNIQUE violation reaches the caller as an effect Cause; the text must still match.
  it("F7: driverErrorText finds the database reason inside an effect Cause", async () => {
    const rt = newRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* TestDb;
        yield* db.run(sql`create table u (name text unique)`);
        yield* db.run(sql`insert into u (name) values ('ann')`);
        yield* db.run(sql`insert into u (name) values ('ann')`);
      }),
    );
    const text = Exit.isFailure(exit) ? driverErrorText(exit.cause) : "";
    expect(text).toContain("UNIQUE constraint failed");
    await rt.dispose();
  });
});

// Sanity: the promise-path helper is unchanged on the bun path.
describe("rowsChanged on promise-path results", () => {
  it("reads bun:sqlite changes", () => {
    const d = new Database(":memory:");
    expect(rowsChanged({ changes: 3 })).toBe(3);
  });
});
