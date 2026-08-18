import * as schema from "@cire/db";
import type { BatchItem } from "drizzle-orm/batch";
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

/**
 * A non-empty statement list — the shape `batch()` demands (D1 rejects an empty
 * batch), so callers filter out the empty case before building one.
 */
export type BatchStatements = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/**
 * The `.batch()` half of a Drizzle handle, as an OPTIONAL member — only the D1
 * driver has it, bun:sqlite does not, so every caller feature-detects it (see
 * {@link commitBatch}). Kept here as one named type rather than re-declared at
 * each of the three call sites (`commitBatch`, the importer's write-set commit,
 * session rotation).
 *
 * The result is `Promise<void>`: D1 resolves one `D1Result` per statement, but
 * no caller in this codebase reads them — what a batch guarantees is that every
 * statement committed together, which you get by awaiting. TypeScript's
 * "return value is ignored" rule keeps D1's real, richer signature assignable.
 */
export type BatchableDb = {
  batch?: (statements: BatchStatements) => Promise<void>;
};

/**
 * Commit a list of Drizzle write statements as one atomic D1 batch (production)
 * or sequentially on bun:sqlite (tests/local). Feature-detects `.batch()` — the
 * same path the importer, retention sweep, and code-rotation services use. An
 * empty list is a no-op. The atomicity is a correctness property for callers
 * that must apply all-or-nothing (e.g. rotating a code AND revoking its sessions
 * in the same commit).
 */
export async function commitBatch(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (statements.length === 0) return;
  const batchable = db as BatchableDb;
  if (typeof batchable.batch === "function") {
    await batchable.batch(statements as BatchStatements);
    return;
  }
  // eslint-disable-next-line no-await-in-loop
  for (const stmt of statements) await stmt;
}

/**
 * D1 Free-tier ceiling on statements per `batch()` invocation. Callers whose
 * write set can grow with data volume must chunk beneath it — a single
 * over-limit batch fails outright. Mirrored by the importer's write-set
 * chunking (`services/import.ts`).
 */
export const MAX_STATEMENTS_PER_BATCH = 50;

/**
 * Commit GROUPS of statements in batches of at most `MAX_STATEMENTS_PER_BATCH`,
 * never splitting a group across two batches. For write sets that scale with
 * data volume (one small statement-group per row — e.g. the bulk code remint's
 * [code update, session revoke] pair per family), this keeps each group atomic
 * while staying under D1's per-batch ceiling. Whole-set atomicity is
 * deliberately given up — the same trade the importer makes — so callers must
 * be shaped to tolerate a mid-run failure (each group idempotent / re-runnable).
 * A single group larger than the ceiling still commits (as its own oversized
 * batch) rather than being silently split; D1 will reject it, which is the
 * correct loud failure for an unshaped caller.
 */
export async function commitGroupedBatches(db: Db, groups: BatchItem<"sqlite">[][]): Promise<void> {
  let chunk: BatchItem<"sqlite">[] = [];
  for (const group of groups) {
    if (chunk.length > 0 && chunk.length + group.length > MAX_STATEMENTS_PER_BATCH) {
      // eslint-disable-next-line no-await-in-loop
      await commitBatch(db, chunk);
      chunk = [];
    }
    chunk.push(...group);
  }
  await commitBatch(db, chunk);
}
