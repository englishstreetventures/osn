/**
 * The orphan walk shared by cire's R2 reconcilers: `asset-reconcile.ts` for the
 * `cire-assets` invite images and `sheet-reconcile.ts` for the `cire-sheets`
 * uploads and before-images.
 *
 * cire stores R2 keys in D1 rows, and every flow that deletes or rewrites those
 * rows deletes the objects best-effort afterwards (`reapR2Objects`). When that
 * delete fails the object is referenced by nothing and nothing retries it. A
 * reconciler lists one bucket prefix and deletes what no live row names.
 *
 * ───────────────────────────── DESTRUCTIVE-RISK ──────────────────────────────
 * This deletes couples' photos and guests' spreadsheets. Every guard below
 * makes "delete the wrong thing" impossible rather than unlikely:
 *
 *  1. ABORT ON UNCERTAINTY — the caller's referenced-key read runs first. If it
 *     fails, or returns an EMPTY set while the prefix holds objects, nothing is
 *     deleted. A successful read that is wrong (wrong binding, a table rebuilt
 *     empty, a query bug) looks exactly like "nothing is live", so an empty set
 *     is never trusted.
 *  2. GRACE PERIOD — only objects R2 says were uploaded more than
 *     {@link RECONCILE_GRACE_MS} ago are candidates, so an object whose row is
 *     written a moment after it (every writer puts first, then writes the row)
 *     is never reaped.
 *  3. PREFIX SCOPING — only keys under the plan's prefix are considered, even if
 *     a listing returns others.
 *  4. DELETE LAST, CAPPED — candidates are collected over the whole walk and
 *     deleted after it, at most {@link RECONCILE_DELETE_CAP} a run, through
 *     {@link reapR2Objects}. A list failure part-way therefore deletes nothing.
 *
 * Runs off the hot path only, from the Worker's `scheduled` cron handler.
 */
import { Data, Effect } from "effect";

import { metricR2ObjectsSwept } from "../metrics";
import { reapR2Objects } from "./r2-cleanup";
import type { DeletableBucket, R2BucketLabel } from "./r2-cleanup";

/** An object uploaded less than this long ago is never a candidate: 7 days. */
export const RECONCILE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Most objects one run deletes. A larger backlog is left for the next run; the
 * orphans are stable, so nothing is lost by waiting. One multi-key R2 delete.
 */
export const RECONCILE_DELETE_CAP = 500;

/** Most objects one `list()` page may request — R2's documented ceiling. */
const LIST_PAGE_SIZE = 1000;

/**
 * Listable and deletable R2. Cloudflare's `R2Bucket` satisfies this
 * structurally; the delete half is exactly {@link DeletableBucket}, because the
 * bucket goes straight to {@link reapR2Objects}.
 */
export interface ReconcilableBucket extends DeletableBucket {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: ReadonlyArray<{ key: string; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * How much of a bucket one run may list. Every object a page returns counts
 * toward `maxObjects`, and every `list()` call toward `maxListCalls` — R2 may
 * return a short page that is still truncated, so objects alone do not bound
 * the calls. A run that reaches either limit logs that it stopped; the objects
 * past that point are not looked at by this run.
 */
export interface ListBudget {
  readonly maxObjects: number;
  readonly maxListCalls: number;
}

export interface ReconcilePlan<R> {
  readonly label: R2BucketLabel;
  /** Only keys under this prefix are listed or deleted. */
  readonly prefix: string;
  /** Every key a live row names. A defect here aborts the run. */
  readonly referencedKeys: Effect.Effect<ReadonlySet<string>, never, R>;
  /** Absent: the whole prefix is walked every run. */
  readonly budget?: ListBudget;
}

export class R2ReconcileError extends Data.TaggedError("R2ReconcileError")<{
  bucket: R2BucketLabel;
  reason: string;
}> {}

/**
 * Delete the objects under `plan.prefix` that no referenced key names and that
 * are older than the grace window. Returns how many were handed to the reaper;
 * 0 when the run aborts or finds nothing.
 *
 * @param bucket the bucket binding. Absent: nothing to reconcile.
 * @param now    the clock the grace window is measured against.
 */
export function reconcileOrphanObjects<R>(
  bucket: ReconcilableBucket | undefined,
  plan: ReconcilePlan<R>,
  now: Date,
): Effect.Effect<number, R2ReconcileError, R> {
  const { label, prefix, budget } = plan;
  return Effect.gen(function* () {
    if (!bucket) {
      yield* Effect.logInfo("r2 reconcile skipped — bucket binding absent", { bucket: label });
      return 0;
    }

    // Guard 1, first half: no live set, no deletes.
    const referenced = yield* plan.referencedKeys.pipe(
      Effect.catchDefect((cause) =>
        Effect.fail(new R2ReconcileError({ bucket: label, reason: String(cause) })),
      ),
      Effect.tapError((err) =>
        Effect.logWarning("r2 reconcile aborted — referenced-key read failed", {
          bucket: label,
          reason: err.reason,
        }),
      ),
    );

    const cutoff = now.getTime() - RECONCILE_GRACE_MS;
    const orphans: string[] = [];
    let prefixHasObjects = false;
    let capped = false;
    let budgetSpent = false;
    let examined = 0;
    let listCalls = 0;
    let cursor: string | undefined;

    while (true) {
      if (budget && (examined >= budget.maxObjects || listCalls >= budget.maxListCalls)) {
        budgetSpent = true;
        break;
      }
      const limit = budget
        ? Math.min(LIST_PAGE_SIZE, budget.maxObjects - examined)
        : LIST_PAGE_SIZE;
      const page = yield* Effect.tryPromise({
        try: () => bucket.list({ prefix, cursor, limit }),
        catch: (cause) =>
          new R2ReconcileError({ bucket: label, reason: `list failed: ${String(cause)}` }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logWarning("r2 reconcile aborted — bucket list failed", {
            bucket: label,
            reason: err.reason,
          }),
        ),
      );
      listCalls += 1;
      examined += page.objects.length;

      for (const obj of page.objects) {
        // Guard 3: never trust the listing to have honoured the prefix.
        if (!obj.key.startsWith(prefix)) continue;
        prefixHasObjects = true;
        if (referenced.has(obj.key)) continue;
        // Guard 2: too new to judge.
        if (obj.uploaded.getTime() >= cutoff) continue;
        orphans.push(obj.key);
        if (orphans.length >= RECONCILE_DELETE_CAP) {
          capped = true;
          break;
        }
      }
      if (capped || !page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }

    if (budgetSpent) {
      yield* Effect.logWarning(
        "r2 reconcile stopped at its per-run listing budget — objects past it were not walked",
        { bucket: label, examined, listCalls },
      );
    }

    // Guard 1, second half: an empty live set against a non-empty prefix.
    if (referenced.size === 0 && prefixHasObjects) {
      yield* Effect.logWarning(
        "r2 reconcile aborted — referenced-key set empty while bucket non-empty (delete-nothing safeguard)",
        { bucket: label, orphanCandidates: orphans.length },
      );
      return 0;
    }

    if (orphans.length === 0) {
      yield* Effect.logInfo("r2 reconcile complete — no orphans", {
        bucket: label,
        referenced: referenced.size,
        examined,
      });
      return 0;
    }

    if (capped) {
      yield* Effect.logWarning("r2 reconcile hit its per-run delete cap — next run continues", {
        bucket: label,
        cap: RECONCILE_DELETE_CAP,
      });
    }

    // Guard 4: the only delete. Best-effort; failures are logged and counted on
    // `cire.r2.objects.swept` and never fail the run.
    yield* reapR2Objects(bucket, label, orphans);

    yield* Effect.logInfo("r2 reconcile complete", {
      bucket: label,
      referenced: referenced.size,
      examined,
      deleted: orphans.length,
      capped,
    });
    return orphans.length;
  }).pipe(
    // Each failure is logged above; this adds the one error count per run.
    Effect.tapError(() => Effect.sync(() => metricR2ObjectsSwept(label, "error"))),
  );
}
