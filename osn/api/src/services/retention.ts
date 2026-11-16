/**
 * Retention sweeps: batched deletes of rows past their retention window, run
 * by the Worker's 6-hourly `scheduled` handler and the Bun sweeper in
 * `local.ts`. Every sweep goes through {@link runRetentionSweep}, which keeps
 * the sweeper design contract in `wiki/compliance/retention.md`: chunked
 * deletes, a pause between two chunks, a cap on chunks a pass, and the
 * `osn.retention.*` metrics on every pass.
 */

import { emailChanges, handleHolds, securityEvents } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { rowsChanged } from "@shared/db-utils";
import { inArray, lte, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Clock, Effect } from "effect";

import { metricRetentionSweep, type RetentionTable } from "../metrics";
import { DatabaseError } from "./auth/errors";

/**
 * How long a `security_events` row is kept: 12 months from `created_at`
 * (`wiki/compliance/retention.md`, the `security_events` row). In seconds.
 */
export const SECURITY_EVENT_RETENTION_SECONDS = 365 * 24 * 60 * 60;

/**
 * How long an `email_changes` row is kept: 90 days from `completed_at`
 * (`wiki/compliance/retention.md`, the `email_changes` audit row). In seconds.
 */
export const EMAIL_CHANGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Bounds on one pass of the `security_events`, `email_changes` and
 * `handle_holds` sweeps: chunks of this many rows, at most this many chunks.
 * Two chunks is two of the 50 D1 queries a Workers Free cron invocation has,
 * shared by every sweep of the tick; anything left goes on the next run, six
 * hours later.
 */
export const RETENTION_SWEEP_CHUNK = 500;
export const RETENTION_SWEEP_MAX_CHUNKS = 2;

/**
 * Pause between two chunks of one pass, so requests waiting to write run
 * between the sweep's deletes. Never after the last chunk.
 */
export const RETENTION_SWEEP_PAUSE_MS = 75;

/** One sweep, as {@link runRetentionSweep} runs it. */
export interface RetentionSweep {
  /** The `table` the pass is counted under on `osn.retention.*`. */
  readonly table: RetentionTable;
  /** Deletes at most `size` expired rows, and resolves with how many it deleted. */
  readonly chunk: (db: DbService["db"], size: number) => PromiseLike<number>;
  /** The most chunks one pass deletes. */
  readonly maxChunks: number;
  /** The pass's span. */
  readonly span: string;
  /** Logged, with the chunk count and rows deleted, when every chunk came back full. */
  readonly fullChunkWarning: string;
  /** Rows a chunk; {@link RETENTION_SWEEP_CHUNK} unless set. */
  readonly chunkSize?: number;
  /** Pause between two chunks; {@link RETENTION_SWEEP_PAUSE_MS} unless set. */
  readonly pauseMs?: number;
}

/**
 * One chunk of a sweep of `table`: `DELETE … WHERE rowid IN (SELECT rowid …
 * WHERE <expired> LIMIT n)`. The subquery binds the same few values whatever
 * the chunk size, never one per row, and the range in `expired` can use the
 * column's index. Resolves with the rows deleted, as either driver reports
 * them (`rowsChanged`).
 */
export const expiredChunk =
  (table: SQLiteTable, expired: SQL | undefined) =>
  (db: DbService["db"], size: number): PromiseLike<number> =>
    db
      .delete(table)
      .where(
        inArray(
          sql`rowid`,
          db
            .select({ rowid: sql<number>`rowid` })
            .from(table)
            .where(expired)
            .limit(size),
        ),
      )
      .then(rowsChanged);

/**
 * Deletes a sweep's expired rows a chunk at a time, at most `maxChunks` of
 * them, so one pass's writes and statements stay bounded however far behind
 * the table is. Stops at the first chunk that comes back short. A pass whose
 * every chunk came back full has likely left rows behind, and logs
 * `fullChunkWarning` so a backlog shows in the Worker's logs.
 *
 * Each pass, failed or not, adds the rows it deleted to
 * `osn.retention.rows_deleted` and its time, pauses included, to
 * `osn.retention.cycle.duration`, both under `table`.
 */
export const runRetentionSweep = (
  sweep: RetentionSweep,
): Effect.Effect<{ deleted: number }, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const size = sweep.chunkSize ?? RETENTION_SWEEP_CHUNK;
    const pauseMs = sweep.pauseMs ?? RETENTION_SWEEP_PAUSE_MS;
    const startedAt = yield* Clock.currentTimeMillis;
    let deleted = 0;
    const deleteChunk = Effect.tryPromise({
      try: () => sweep.chunk(db, size),
      catch: (cause) => new DatabaseError({ cause }),
    });
    yield* Effect.gen(function* () {
      for (let chunk = 0; chunk < sweep.maxChunks; chunk++) {
        if (chunk > 0) yield* Effect.sleep(pauseMs);
        const changed = yield* deleteChunk;
        deleted += changed;
        if (changed < size) return;
      }
      // Every chunk came back full, so expired rows are likely still there.
      yield* Effect.logWarning(sweep.fullChunkWarning).pipe(
        Effect.annotateLogs({ chunks: sweep.maxChunks, deleted }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const endedAt = yield* Clock.currentTimeMillis;
          metricRetentionSweep(sweep.table, deleted, (endedAt - startedAt) / 1000);
        }),
      ),
    );
    return { deleted };
  }).pipe(Effect.withSpan(sweep.span));

/** Unix seconds of `nowMs`, or of the moment the pass runs. */
const nowSeconds = (nowMs: number | undefined): number => Math.floor((nowMs ?? Date.now()) / 1000);

/**
 * Deletes `security_events` rows once {@link SECURITY_EVENT_RETENTION_SECONDS}
 * old (`created_at <= now − 365 days`), over `security_events_created_at_idx`.
 */
export const runSecurityEventSweep = (
  opts: { nowMs?: number } = {},
): Effect.Effect<{ deleted: number }, DatabaseError, Db> =>
  Effect.suspend(() =>
    runRetentionSweep({
      table: "security_events",
      chunk: expiredChunk(
        securityEvents,
        lte(securityEvents.createdAt, nowSeconds(opts.nowMs) - SECURITY_EVENT_RETENTION_SECONDS),
      ),
      maxChunks: RETENTION_SWEEP_MAX_CHUNKS,
      span: "retention.sweep.security_events",
      fullChunkWarning: "retention.sweep.security_events ended on a full chunk",
    }),
  );

/**
 * Deletes `email_changes` rows once {@link EMAIL_CHANGE_RETENTION_SECONDS}
 * past `completed_at` (`completed_at <= now − 90 days`), over
 * `email_changes_completed_at_idx`. The 2-per-7-days cap reads only the last
 * 7 days, so the sweep never changes what it counts.
 */
export const runEmailChangeSweep = (
  opts: { nowMs?: number } = {},
): Effect.Effect<{ deleted: number }, DatabaseError, Db> =>
  Effect.suspend(() =>
    runRetentionSweep({
      table: "email_changes",
      chunk: expiredChunk(
        emailChanges,
        lte(emailChanges.completedAt, nowSeconds(opts.nowMs) - EMAIL_CHANGE_RETENTION_SECONDS),
      ),
      maxChunks: RETENTION_SWEEP_MAX_CHUNKS,
      span: "retention.sweep.email_changes",
      fullChunkWarning: "retention.sweep.email_changes ended on a full chunk",
    }),
  );

/**
 * Deletes `handle_holds` rows from the second of their release
 * (`release_at <= now`), over `handle_holds_release_idx`. From that second a
 * hold no longer refuses its handle, so deleting it changes no answer. A hold
 * whose deletion is pending has a NULL `release_at`, which no comparison
 * matches: the sweep never touches it.
 */
export const runHandleHoldSweep = (
  opts: { nowMs?: number } = {},
): Effect.Effect<{ deleted: number }, DatabaseError, Db> =>
  Effect.suspend(() =>
    runRetentionSweep({
      table: "handle_holds",
      chunk: expiredChunk(handleHolds, lte(handleHolds.releaseAt, nowSeconds(opts.nowMs))),
      maxChunks: RETENTION_SWEEP_MAX_CHUNKS,
      span: "retention.sweep.handle_holds",
      fullChunkWarning: "retention.sweep.handle_holds ended on a full chunk",
    }),
  );
