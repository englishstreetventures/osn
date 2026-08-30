import type { D1Database } from "@cloudflare/workers-types";
import type { Relations } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase, SQLiteTable, SQLiteView } from "drizzle-orm/sqlite-core";
import { Effect, Layer, type Context } from "effect";

/**
 * A Drizzle schema — the `import * as schema from "./schema"` namespace each DB
 * package (`@osn/db`, `@pulse/db`, `@zap/db`) hands to the constructors below.
 * Its runtime exports are tables, views and relations blocks; the
 * `$inferSelect` / `$inferInsert` aliases sitting beside them are types and
 * disappear at runtime, so they never reach this map.
 *
 * Drizzle's own constraint on the schema generic is `Record<string, unknown>`,
 * which promises a caller nothing. Naming the three things a schema can hold
 * keeps the constraint assignable to Drizzle's while still saying what belongs.
 */
export type DrizzleSchema = Record<string, SQLiteTable | SQLiteView | Relations>;

/**
 * The Drizzle handle threaded through every service, broadened over both SQLite
 * result kinds so the *same* query code runs against two drivers:
 *  - `bun:sqlite` — synchronous; the `local` environment: dev servers
 *    (`makeDbLive`) and the unit-test suite (`createTestLayer()`).
 *  - Cloudflare D1 — asynchronous; the `dev` / `staging` / `prod` environments,
 *    where each API runs on Workers (`makeD1DbLive` / `createD1Db`).
 *
 * Because the result kind is `"sync" | "async"`, `.all()` / `.get()` / `.run()`
 * resolve to `T | Promise<T>`, so callers MUST `await` every query (in practice
 * via `Effect.tryPromise` / `dbQuery`). Awaiting a synchronous bun:sqlite result
 * is a harmless no-op; D1 returns a real Promise. `unknown` for the run-result
 * type covers bun's `void` and D1's `D1Result`.
 */
export type Db<S extends DrizzleSchema> = BaseSQLiteDatabase<"sync" | "async", unknown, S>;

/**
 * Construct a bun:sqlite-backed Drizzle client. Used by the `local` environment
 * only (dev servers + tests). The concrete {@link BunSQLiteDatabase} is
 * assignable to the broadened {@link Db}, so call sites stay portable to D1.
 *
 * `bun:sqlite` and `drizzle-orm/bun-sqlite` are imported **dynamically** so they
 * never enter a Cloudflare Workers bundle. The Workers entry only touches
 * `createD1Db` / `makeD1DbLive` (which use `drizzle-orm/d1`); `DbLive` is
 * evaluated at module load but `makeDbLive` returns a lazy Layer that doesn't
 * reach this function until the `local` layer is actually built — which never
 * happens on Workers. wrangler/esbuild cannot resolve `bun:sqlite`, so a static
 * import here would break every Worker build.
 */
export async function createDrizzleClient<S extends DrizzleSchema>(
  dbPath: string,
  schema: S,
): Promise<BunSQLiteDatabase<S>> {
  // Indirect (non-literal) specifiers so esbuild/wrangler cannot statically
  // resolve them — it leaves both as runtime imports instead of pulling
  // `bun:sqlite` (Bun-only, unresolvable in workerd) into the Worker bundle.
  // This code runs only on Bun (`local` dev + tests); it is never executed on
  // Workers, so the runtime import never fires there.
  const bunSqlite = "bun:sqlite";
  const bunSqliteDriver = "drizzle-orm/bun-sqlite";
  const { Database } = (await import(bunSqlite)) as typeof import("bun:sqlite");
  const { drizzle } = (await import(bunSqliteDriver)) as typeof import("drizzle-orm/bun-sqlite");
  const sqlite = new Database(dbPath);
  // SQLite defaults `foreign_keys` to OFF, so every reference declared in the
  // schema is unenforced on Bun while D1 enforces them. That makes the cheap,
  // fast environment the permissive one: a statement that orphans a row, or
  // deletes a parent before its children, passes the whole suite and fails on
  // deploy with `FOREIGN KEY constraint failed`. Turning it on here is what
  // makes local runs and tests agree with production about what is a legal
  // write.
  sqlite.run("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function makeDbLive<S extends DrizzleSchema, A extends { readonly db: Db<S> }>(
  tag: Context.Tag<any, A>,
  // Accepts a thunk so a caller whose path derivation is Bun-only (e.g.
  // `fileURLToPath(import.meta.url)`, which throws on workerd where
  // `import.meta.url` is undefined) can defer it INTO the lazy Layer. On the
  // Workers runtime `DbLive` is imported as a value but its layer is never
  // built (the entry uses `makeD1DbLive`), so the thunk never runs there.
  dbPath: string | (() => string),
  schema: S,
) {
  return Layer.effect(
    tag,
    Effect.promise(
      async () =>
        ({
          db: await createDrizzleClient(typeof dbPath === "function" ? dbPath() : dbPath, schema),
        }) as A,
    ),
  );
}

/**
 * Construct a Drizzle client over a Cloudflare D1 binding. Called per isolate in
 * a Workers entry point — Workers have no long-lived process, so the binding
 * only exists on `env` inside `fetch`. Drives the `dev` / `staging` / `prod`
 * environments.
 */
export function createD1Db<S extends DrizzleSchema>(d1: D1Database, schema: S): Db<S> {
  return drizzleD1(d1, { schema });
}

/**
 * Build a `Db` service Layer over a Cloudflare D1 binding, mirroring the shape
 * of {@link makeDbLive} so Workers entry points can swap drivers with a one-line
 * change (`makeDbLive(...)` → `makeD1DbLive(...)`).
 */
export function makeD1DbLive<S extends DrizzleSchema>(
  tag: Context.Tag<any, { readonly db: Db<S> }>,
  d1: D1Database,
  schema: S,
) {
  return Layer.succeed(tag, { db: createD1Db(d1, schema) });
}

/**
 * Run a Drizzle query as an Effect, bridging the sync/async driver split.
 *
 * `.all()` / `.get()` / `.run()` return a plain value on bun:sqlite and a
 * Promise on D1; `Promise.resolve` normalises both. A throw surfaces as a
 * defect — for writes that need a typed error, use `Effect.tryPromise` instead
 * so the failure lands in the error channel.
 */
export const dbQuery = <A>(run: () => A | Promise<A>): Effect.Effect<A> =>
  Effect.promise(() => Promise.resolve(run()));

/**
 * Commit a write set atomically across both drivers. D1 has no interactive
 * transaction (`db.transaction(async tx => …)`), so flows that need
 * all-or-nothing semantics build their statements up front — in FK-dependency
 * order — and hand them here:
 *  - D1 (`dev`/`staging`/`prod`): a single `db.batch([...])`. A batch IS a
 *    transaction, so this is atomic and one round-trip.
 *  - bun:sqlite (`local`/tests): no `.batch()` exists; awaited sequentially in
 *    the same order. In-process, so no round-trip cost.
 *
 * `batch` exists only on the async D1 driver, so feature-detection picks the
 * path — the same call site works on both. Mirrors the in-repo idiom first used
 * by `cire/api`'s `commitWriteSet`.
 */
type Batchable = {
  /**
   * D1 answers with one driver result per statement, in order. `commitBatch`
   * wants the write committed, not the results — so the reply is typed `void`
   * (which any return type satisfies) rather than handed on as `unknown` for a
   * caller to guess at. A call site that needs the results should reach for the
   * driver's own `batch`, which types them properly.
   */
  batch: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<void>;
};

/**
 * True when this handle is the D1 driver, which is the only one carrying
 * `.batch()`. The broadened {@link Db} type doesn't declare it (bun:sqlite has
 * no such method), so the check is a real property probe rather than a claim
 * about the type.
 */
function supportsBatch<S extends DrizzleSchema>(db: Db<S>): db is Db<S> & Batchable {
  return "batch" in db && typeof db.batch === "function";
}

export async function commitBatch<S extends DrizzleSchema>(
  db: Db<S>,
  statements: BatchItem<"sqlite">[],
): Promise<void> {
  if (statements.length === 0) return;
  if (supportsBatch(db)) {
    // Non-empty by the guard above; TS can't narrow an array's length.
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return;
  }
  // Sequential FK order, in-process — bun:sqlite has no batch. Chained rather
  // than gathered with `Promise.all`: the caller built the list children-first
  // and running it together would drop a parent out from under a child.
  await statements.reduce<Promise<unknown>>(
    (chain, stmt) => chain.then(() => stmt),
    Promise.resolve<unknown>(undefined),
  );
}

/**
 * Rows changed by a Drizzle write, normalised across the drivers this repo
 * runs on.
 *
 * The shape differs per driver and none of them agree:
 *
 * - bun:sqlite / better-sqlite3 → `{ changes }`
 * - libsql                      → `{ rowsAffected }`
 * - Cloudflare D1               → `{ success, meta: { changes, ... } }`
 *
 * Tests run on bun:sqlite, production runs on D1. Reading only the top-level
 * fields therefore passes every test and returns 0 for every write in
 * production — which silently inverted two of `@osn/api`'s compare-and-swap
 * gates (refresh rotation, passkey rename) into always-fail. Every
 * rows-affected check must go through here.
 */
export function rowsChanged(result: unknown): number {
  if (typeof result !== "object" || result === null) return 0;
  const r = result as {
    changes?: number;
    rowsAffected?: number;
    meta?: { changes?: number } | null;
  };
  return r.meta?.changes ?? r.changes ?? r.rowsAffected ?? 0;
}

/**
 * Search primitives (query normalisation, LIKE escaping, index-friendly handle
 * prefix ranges). Re-exported so the barrel stays the one import for DB-adjacent
 * helpers; `@shared/db-utils/search` reaches the same module without the
 * drizzle/effect graph above.
 */
export {
  escapeLike,
  handlePrefixRange,
  hasScanworthyToken,
  joinTokens,
  likeContains,
  normaliseHandleQuery,
  tokenContentLength,
  tokeniseQuery,
  tokensPrefixName,
} from "./search";
