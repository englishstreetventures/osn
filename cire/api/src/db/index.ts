import * as schema from "@cire/db";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Context, Effect } from "effect";

/**
 * The Drizzle handle threaded through every service.
 *
 * Broadened over both SQLite result kinds so the *same* query code runs against
 * two drivers:
 *  - `bun:sqlite` — synchronous; local dev (`local.ts`) + the test suite.
 *  - Cloudflare D1 — asynchronous; production (`index.ts` → `createD1Db`).
 *
 * Because the result kind is `"sync" | "async"`, `.all()` / `.get()` / `.run()`
 * resolve to `T | Promise<T>`, so callers MUST `await` every query. Awaiting a
 * synchronous bun:sqlite result is a harmless no-op; D1 returns a real Promise.
 * `unknown` for the run-result type covers bun's `void` and D1's `D1Result`.
 */
export type Db = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export class DbService extends Context.Tag("DbService")<DbService, Db>() {}

/**
 * Construct a Drizzle client over a Cloudflare D1 binding. Called per request in
 * the Workers entry point (`index.ts`) — Workers have no long-lived process, so
 * the binding only exists on `env` inside `fetch`.
 */
export function createD1Db(d1: D1Database): Db {
  return drizzleD1(d1, { schema });
}

/**
 * Run a Drizzle query as an Effect, bridging the sync/async driver split.
 *
 * `.all()` / `.get()` / `.run()` return a plain value on bun:sqlite and a
 * Promise on D1; `Promise.resolve` normalises both. `await` cannot be used
 * inside `Effect.gen` generators, so reads inside a service are written
 * `yield* dbQuery(() => db.select()…all())`. A throw surfaces as a defect —
 * for writes that need a typed error, use `Effect.tryPromise` instead so the
 * failure lands in the error channel.
 */
export const dbQuery = <A>(run: () => A | Promise<A>): Effect.Effect<A> =>
  Effect.promise(() => Promise.resolve(run()));
