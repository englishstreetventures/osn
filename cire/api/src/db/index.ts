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
 * each call site (`commitBatch`, `commitGroupedBatchesReturning`, the importer's
 * write-set commit, session rotation).
 *
 * The result is one element per statement, in statement order. Write-only
 * callers ignore it — what a batch guarantees them is that every statement
 * committed together, which you get by awaiting. A caller that ends its batch
 * with a SELECT reads the last element for that SELECT's rows (see
 * {@link commitGroupedBatchesReturning}); Drizzle's D1 session maps a SELECT
 * result to rows for us, so the element is already the row array.
 */
export type BatchableDb = {
  batch?: (statements: BatchStatements) => Promise<unknown[]>;
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
  // bun:sqlite (tests/local): no `.batch()`. Callers hand these over in FK
  // order — children before parents — so the statements are chained rather
  // than gathered with `Promise.all`, which would run a parent's write
  // alongside the child's and lose the ordering the caller relies on.
  await statements.reduce<Promise<unknown>>(
    (chain, stmt) => chain.then(() => stmt),
    Promise.resolve<unknown>(undefined),
  );
}

/**
 * D1 Free-tier ceiling on statements per `batch()` invocation. Callers whose
 * write set can grow with data volume must chunk beneath it — a single
 * over-limit batch fails outright. Mirrored by the importer's write-set
 * chunking (`services/import.ts`).
 */
export const MAX_STATEMENTS_PER_BATCH = 50;

/**
 * Pack groups into chunks of at most `MAX_STATEMENTS_PER_BATCH` statements,
 * never splitting a group across two chunks. Shared by
 * {@link commitGroupedBatches} and {@link commitGroupedBatchesReturning} so the
 * two cannot drift. The final chunk is always returned, even when empty — the
 * grouped-batch caller hands an empty chunk to {@link commitBatch}, which no-ops
 * on it, and the returning caller pops it to decide where the tail read rides.
 * A single group larger than the ceiling becomes its own oversized chunk rather
 * than being silently split; D1 rejects it, which is the correct loud failure.
 */
function chunkGroups(groups: BatchItem<"sqlite">[][]): BatchItem<"sqlite">[][] {
  const chunks: BatchItem<"sqlite">[][] = [];
  let chunk: BatchItem<"sqlite">[] = [];
  for (const group of groups) {
    if (chunk.length > 0 && chunk.length + group.length > MAX_STATEMENTS_PER_BATCH) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(...group);
  }
  chunks.push(chunk);
  return chunks;
}

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
  // Chained, not gathered: chunk N+1 may depend on rows chunk N wrote, which
  // is exactly why the set was split in the first place.
  await chunkGroups(groups).reduce<Promise<void>>(
    (chain, chunk) => chain.then(() => commitBatch(db, chunk)),
    Promise.resolve(),
  );
}

/**
 * The trailing read `commitGroupedBatchesReturning` appends to the write
 * batch. It must be batchable (rides inside `db.batch()`, same as any write
 * statement) AND directly awaitable (the bun:sqlite fallback just awaits it
 * in place) — a real Drizzle select builder is both.
 */
export type ReturningTail<T> = BatchItem<"sqlite"> & PromiseLike<T[]>;

/**
 * Commit GROUPS of statements exactly as {@link commitGroupedBatches} does,
 * then run one trailing read and return its rows — folding a read-back into
 * the same D1 round-trip as the write that produced it, instead of a second
 * one after (P-W1).
 *
 * The tail rides in the FINAL chunk when it fits under
 * `MAX_STATEMENTS_PER_BATCH`; if appending it would push that chunk over the
 * ceiling, it ships as its own trailing batch instead. Either way it ends up
 * the last statement of the last batch actually sent, so its rows are always
 * `results.at(-1)` of that batch — D1 returns one result per statement, and
 * `drizzle-orm@0.45.2`'s `d1/session` maps a SELECT's element to its rows via
 * `mapResult(result, true)`. Correctness never depends on the tail sharing a
 * batch with the writes (every earlier batch is already committed by the
 * time the next one runs) — only the saved round-trip does.
 *
 * bun:sqlite has no `.batch()`: every statement, including the tail, just
 * runs in order in-process, same as {@link commitBatch}'s fallback — chunking
 * is a D1-only concern there. An empty `groups` list is legal: the tail still
 * runs and still returns rows.
 *
 * Whole-set atomicity is given up beyond the ceiling, the same trade
 * `commitGroupedBatches` makes — callers must tolerate a mid-run failure
 * (each group idempotent / re-runnable).
 */
export async function commitGroupedBatchesReturning<T>(
  db: Db,
  groups: BatchItem<"sqlite">[][],
  tail: ReturningTail<T>,
): Promise<T[]> {
  // Bound and captured before the guard, so the narrowing survives into the
  // closure below — a property read off a mutable object does not — and so the
  // driver method keeps its receiver.
  const batchable = db as BatchableDb;
  const batch = typeof batchable.batch === "function" ? batchable.batch.bind(batchable) : null;
  if (!batch) {
    // Same FK ordering as commitBatch's fallback, so the same chain.
    await groups
      .flat()
      .reduce<Promise<unknown>>(
        (chain, stmt) => chain.then(() => stmt),
        Promise.resolve<unknown>(undefined),
      );
    return await tail;
  }

  const chunks = chunkGroups(groups);
  const last = chunks.pop() ?? [];
  if (last.length + 1 <= MAX_STATEMENTS_PER_BATCH) {
    chunks.push([...last, tail]);
  } else {
    chunks.push(last, [tail]);
  }

  // Chained for the same reason as commitGroupedBatches, and because only the
  // LAST batch's result is wanted: the tail read rides in it by construction.
  return await chunks.reduce<Promise<T[]>>(
    (chain, c) =>
      chain.then(async () => {
        const results = await batch(c as BatchStatements);
        return results[results.length - 1] as T[];
      }),
    Promise.resolve<T[]>([]),
  );
}
