/**
 * `createDrizzleClient` is the bun:sqlite constructor behind every `DbLive`
 * layer (`makeDbLive`), which the dev servers and seeds build. No test layer
 * goes through it — they open `:memory:` databases themselves — so these are
 * its only tests.
 *
 * What they pin: the handle writes to the file it was given, and foreign keys
 * are enforced on it. SQLite leaves `foreign_keys` off by default while D1
 * enforces it, and a handle that silently skips it lets an orphaning write pass
 * locally and fail on deploy.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Context, Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDrizzleClient, makeDbLive, type Db } from "../src/index";

const parents = sqliteTable("parents", {
  id: text("id").primaryKey(),
});

const children = sqliteTable("children", {
  id: text("id").primaryKey(),
  parentId: text("parent_id")
    .notNull()
    .references(() => parents.id),
});

const schema = { parents, children };

const DDL = [
  "CREATE TABLE parents (id TEXT PRIMARY KEY)",
  "CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id))",
];

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-utils-client-"));
  dbPath = join(dir, "test.db");
  const setup = new Database(dbPath);
  for (const statement of DDL) setup.run(statement);
  setup.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createDrizzleClient", () => {
  it("turns foreign-key enforcement on", async () => {
    const db = await createDrizzleClient(dbPath, schema);

    const pragma = await db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);

    expect(pragma).toEqual([{ foreign_keys: 1 }]);
  });

  it("rejects a write that orphans a row", async () => {
    const db = await createDrizzleClient(dbPath, schema);

    expect(() => db.insert(children).values({ id: "c1", parentId: "missing" }).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("creates the database file when none exists at the path", async () => {
    const freshPath = join(dir, "fresh.db");
    expect(existsSync(freshPath)).toBe(false);

    const db = await createDrizzleClient(freshPath, schema);
    await db.run(sql`CREATE TABLE parents (id TEXT PRIMARY KEY)`);

    expect(existsSync(freshPath)).toBe(true);
  });

  it("writes to the file at the path it was given", async () => {
    const db = await createDrizzleClient(dbPath, schema);
    await db.insert(parents).values({ id: "p1" }).run();

    const reader = new Database(dbPath, { readonly: true });
    const rows = reader.query("SELECT id FROM parents").all();
    reader.close();

    expect(rows).toEqual([{ id: "p1" }]);
  });
});

describe("makeDbLive", () => {
  class TestDb extends Context.Service<TestDb, { readonly db: Db<typeof schema> }>()(
    "db-utils/tests/TestDb",
  ) {}

  it("builds a layer whose handle enforces foreign keys", async () => {
    const program = Effect.gen(function* () {
      const { db } = yield* TestDb;
      return yield* Effect.promise(async () =>
        db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`),
      );
    });

    const pragma = await Effect.runPromise(
      program.pipe(Effect.provide(makeDbLive(TestDb, () => dbPath, schema))),
    );

    expect(pragma).toEqual([{ foreign_keys: 1 }]);
  });
});
