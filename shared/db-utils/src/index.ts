import type { D1Database } from "@cloudflare/workers-types";
import type { BatchItem } from "drizzle-orm/batch";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Effect, Layer, type Context } from "effect";

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
export type Db<S extends Record<string, unknown>> = BaseSQLiteDatabase<
  "sync" | "async",
  unknown,
  S
>;

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
export async function createDrizzleClient<S extends Record<string, unknown>>(
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
  return drizzle(sqlite, { schema });
}

export function makeDbLive<S extends Record<string, unknown>, A extends { readonly db: Db<S> }>(
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
export function createD1Db<S extends Record<string, unknown>>(d1: D1Database, schema: S): Db<S> {
  return drizzleD1(d1, { schema });
}

/**
 * Build a `Db` service Layer over a Cloudflare D1 binding, mirroring the shape
 * of {@link makeDbLive} so Workers entry points can swap drivers with a one-line
 * change (`makeDbLive(...)` → `makeD1DbLive(...)`).
 */
export function makeD1DbLive<S extends Record<string, unknown>>(
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
export async function commitBatch<S extends Record<string, unknown>>(
  db: Db<S>,
  statements: BatchItem<"sqlite">[],
): Promise<void> {
  if (statements.length === 0) return;
  const batchable = db as unknown as {
    batch?: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown>;
  };
  if (typeof batchable.batch === "function") {
    await batchable.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return;
  }
  // Sequential FK order, in-process — bun:sqlite has no batch.
  /* eslint-disable-next-line no-await-in-loop */
  for (const stmt of statements) await stmt;
}
