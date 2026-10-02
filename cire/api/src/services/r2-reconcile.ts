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
 *  1. ABORT ON UNCERTAINTY — before judging anything, the plan names one key
 *     that a live row holds ({@link ReconcilePlan.liveSample}). None while the
 *     prefix holds objects aborts the run: a successful read that is wrong
 *     (a table rebuilt empty) looks exactly like "nothing is live". The sample
 *     must also be an object in the bucket being reconciled — every writer
 *     stores the object before the row that names it — so a database paired
 *     with another environment's bucket fails the run. The sample then rides
 *     LAST, and only there, in the list sent to {@link ReconcilePlan.named}, and
 *     the run fails unless it comes back named, so a lookup that drops,
 *     truncates or garbles its input, or matches nothing, deletes nothing.
 *  2. GRACE PERIOD — only objects R2 says were uploaded more than
 *     {@link RECONCILE_GRACE_MS} ago are candidates, so an object whose row is
 *     written a moment after it (every writer puts first, then writes the row)
 *     is never reaped. Age is read from the listing, so a writer that puts an
 *     existing key again, after the listing and before the delete, could lose
 *     that object. The one such writer, an apply retried on a `cire-sheets`
 *     preview, rewrites that preview's before-image, and the stale-preview
 *     sweep removes previews once they are as old as the grace window.
 *  3. PREFIX SCOPING — only keys under the plan's prefix are considered, even if
 *     a listing returns others.
 *  4. DELETE LAST, CAPPED — the reference check runs once, after the walk, and
 *     only keys the walk returned can be deleted: at most
 *     {@link RECONCILE_DELETE_CAP} a run, through {@link reapR2Objects}. A list
 *     failure part-way therefore deletes nothing.
 *
 * A walk with a {@link ListBudget} lists a bounded number of objects a run and
 * keeps its place between runs, so a bucket larger than the budget is covered
 * over several runs — a "lap". The position only chooses where a walk starts;
 * it cannot make an object a candidate.
 *
 * Runs off the hot path only, from the Worker's `scheduled` cron handler.
 */
import { Data, Effect, Option, Schema } from "effect";

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

/**
 * A lap older than this logs a warning on every run: 30 days. It is the signal
 * that a bucket has outgrown its listing budget, since a failed delete's data
 * can outlive its deletion date by up to one lap.
 */
export const LAP_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

/** Most objects one `list()` page may request — R2's documented ceiling. */
const LIST_PAGE_SIZE = 1000;

/**
 * Listable and deletable R2. Cloudflare's `R2Bucket` satisfies this
 * structurally; the delete half is exactly {@link DeletableBucket}, because the
 * bucket goes straight to {@link reapR2Objects}.
 */
export interface ReconcilableBucket extends DeletableBucket {
  head(key: string): Promise<{ key: string } | null>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    limit?: number;
  }): Promise<{
    objects: ReadonlyArray<{ key: string; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

/** The R2 calls {@link r2PositionStore} makes. `R2Bucket` satisfies it. */
export interface PositionBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<R2Object | null | void>;
  delete(keys: string | string[]): Promise<void>;
}

/** Where a budgeted walk stands between runs. */
export interface WalkState {
  /** Every key up to and including this one has been walked this lap; null: none yet. */
  readonly after: string | null;
  /** When the current lap began, epoch milliseconds. */
  readonly lapStartedAt: number;
}

/** Storage for a {@link WalkState}, as text. Either call failing fails the run. */
export interface PositionStore {
  /** The stored text, or undefined when nothing is stored. */
  readonly read: Effect.Effect<string | undefined, R2ReconcileError>;
  /** Store `text`; undefined removes what is stored. */
  readonly write: (text: string | undefined) => Effect.Effect<void, R2ReconcileError>;
}

/** How much of a bucket one run may list. */
export interface ListLimits {
  readonly maxObjects: number;
  /** R2 may return a short page that is still truncated, so objects alone do not bound the calls. */
  readonly maxListCalls: number;
}

/**
 * A walk bounded per run. It always carries a position: without one, every run
 * would start at the first key and the objects past the budget would never be
 * walked.
 */
export interface ListBudget extends ListLimits {
  readonly position: PositionStore;
}

export interface ReconcilePlan<R> {
  readonly label: R2BucketLabel;
  /** Only keys under this prefix are listed or deleted. */
  readonly prefix: string;
  /**
   * One key a live row names, or undefined when no live row names any. Read
   * first, and only in a run that found candidates. A defect aborts the run.
   */
  readonly liveSample: Effect.Effect<string | undefined, never, R>;
  /**
   * A set holding every one of `keys` that a live row names, compared as exact
   * strings, and none of them that no live row names; it may hold other keys
   * too. Called once per run, after the walk. A defect aborts the run.
   */
  readonly named: (keys: ReadonlyArray<string>) => Effect.Effect<ReadonlySet<string>, never, R>;
  /** Absent: the whole prefix is walked every run. */
  readonly budget?: ListBudget;
}

export class R2ReconcileError extends Data.TaggedError("R2ReconcileError")<{
  bucket: R2BucketLabel;
  reason: string;
}> {}

/**
 * A {@link PositionStore} kept as one small JSON object in an R2 bucket. `key`
 * must lie outside every prefix a reconciler walks, so no walk lists it.
 */
export function r2PositionStore(
  bucket: PositionBucket,
  key: string,
  label: R2BucketLabel,
): PositionStore {
  const failed = (op: "read" | "write") => (cause: unknown) =>
    new R2ReconcileError({ bucket: label, reason: `position ${op} failed: ${String(cause)}` });
  return {
    read: Effect.tryPromise({
      try: async () => {
        const object = await bucket.get(key);
        return object ? await object.text() : undefined;
      },
      catch: failed("read"),
    }),
    write: (text) =>
      Effect.tryPromise({
        try: async () => {
          if (text === undefined) await bucket.delete(key);
          else await bucket.put(key, text);
        },
        catch: failed("write"),
      }),
  };
}

const StoredWalkState = Schema.Struct({
  after: Schema.NullOr(Schema.String),
  lapStartedAt: Schema.Number,
});

/**
 * The stored state if it is one a walk of `prefix` could have written by
 * `now`; undefined otherwise.
 */
function parseWalkState(text: string, prefix: string, now: number): WalkState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Option.match(Schema.decodeUnknownOption(StoredWalkState)(parsed), {
    onNone: () => undefined,
    onSome: (state) =>
      (state.after === null || state.after.startsWith(prefix)) &&
      Number.isFinite(state.lapStartedAt) &&
      state.lapStartedAt <= now
        ? state
        : undefined,
  });
}

const sameState = (a: WalkState | undefined, b: WalkState | undefined): boolean =>
  a === b ||
  (a !== undefined && b !== undefined && a.after === b.after && a.lapStartedAt === b.lapStartedAt);

/**
 * Delete the objects under `plan.prefix` that no live row names and that are
 * older than the grace window. Returns how many were handed to the reaper;
 * 0 when the run aborts or finds nothing.
 *
 * @param bucket the bucket binding. Absent: nothing to reconcile.
 * @param now    the clock the grace window and the lap are measured against.
 */
export function reconcileOrphanObjects<R>(
  bucket: ReconcilableBucket | undefined,
  plan: ReconcilePlan<R>,
  now: Date,
): Effect.Effect<number, R2ReconcileError, R> {
  const { label, prefix, budget } = plan;
  const nowMs = now.getTime();

  const warnOnFailure = <A, Req>(
    effect: Effect.Effect<A, R2ReconcileError, Req>,
    message: string,
  ): Effect.Effect<A, R2ReconcileError, Req> =>
    effect.pipe(
      Effect.tapError((err) => Effect.logWarning(message, { bucket: label, reason: err.reason })),
    );

  const fail = (reason: string, message: string) =>
    warnOnFailure(Effect.fail(new R2ReconcileError({ bucket: label, reason })), message);

  const referenceRead = <A>(
    effect: Effect.Effect<A, never, R>,
  ): Effect.Effect<A, R2ReconcileError, R> =>
    warnOnFailure(
      effect.pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(new R2ReconcileError({ bucket: label, reason: String(cause) })),
        ),
      ),
      "r2 reconcile aborted — referenced-key read failed",
    );

  return Effect.gen(function* () {
    if (!bucket) {
      yield* Effect.logInfo("r2 reconcile skipped — bucket binding absent", { bucket: label });
      return 0;
    }

    let state: WalkState | undefined;
    let unreadable = false;
    if (budget) {
      const stored = yield* warnOnFailure(
        budget.position.read,
        "r2 reconcile aborted — position read failed",
      );
      state = stored === undefined ? undefined : parseWalkState(stored, prefix, nowMs);
      unreadable = stored !== undefined && state === undefined;
      if (unreadable) {
        yield* Effect.logWarning("r2 reconcile position unreadable — starting a new lap", {
          bucket: label,
        });
      }
      if (state && nowMs - state.lapStartedAt > LAP_WARNING_MS) {
        yield* Effect.logWarning(
          "r2 reconcile lap has run past its warning window — the listing budget no longer covers the bucket often enough",
          { bucket: label, lapDays: Math.floor((nowMs - state.lapStartedAt) / 86_400_000) },
        );
      }
    }

    const startAfter = state?.after ?? undefined;
    const cutoff = nowMs - RECONCILE_GRACE_MS;
    const candidates: string[] = [];
    let largestKey: string | undefined;
    let reachedEnd = false;
    let examined = 0;
    let listCalls = 0;
    let cursor: string | undefined;

    while (true) {
      if (budget && (examined >= budget.maxObjects || listCalls >= budget.maxListCalls)) break;
      const limit = budget
        ? Math.min(LIST_PAGE_SIZE, budget.maxObjects - examined)
        : LIST_PAGE_SIZE;
      // The first page of a resumed walk starts after the position; later pages
      // follow R2's cursor.
      const options =
        cursor !== undefined
          ? { prefix, cursor, limit }
          : startAfter !== undefined
            ? { prefix, startAfter, limit }
            : { prefix, limit };
      const page = yield* warnOnFailure(
        Effect.tryPromise({
          try: () => bucket.list(options),
          catch: (cause) =>
            new R2ReconcileError({ bucket: label, reason: `list failed: ${String(cause)}` }),
        }),
        "r2 reconcile aborted — bucket list failed",
      );
      listCalls += 1;
      examined += page.objects.length;

      for (const obj of page.objects) {
        // Guard 3: never trust the listing to have honoured the prefix.
        if (!obj.key.startsWith(prefix)) continue;
        // A listing that ignored `startAfter` would walk the front of the bucket
        // every run and never the rest; fail at once rather than in a month.
        if (startAfter !== undefined && obj.key <= startAfter) {
          return yield* fail(
            "list returned a key at or before the resume position",
            "r2 reconcile aborted — list did not honour startAfter",
          );
        }
        if (largestKey === undefined || obj.key > largestKey) largestKey = obj.key;
        // Guard 2: too new to judge.
        if (obj.uploaded.getTime() < cutoff) candidates.push(obj.key);
      }
      if (!page.truncated) {
        reachedEnd = true;
        break;
      }
      // R2 sends a cursor with every truncated page. Without one, stop: the
      // position resumes after what was walked, so the rest is not skipped.
      if (!page.cursor) break;
      cursor = page.cursor;
    }

    let orphans: string[] = [];
    if (candidates.length > 0) {
      // Guard 1: a live sample, or no deletes.
      const sample = yield* referenceRead(plan.liveSample);
      if (sample === undefined) {
        yield* Effect.logWarning(
          "r2 reconcile aborted — no live row names any key while the bucket holds objects (delete-nothing safeguard)",
          { bucket: label, candidates: candidates.length },
        );
        return 0;
      }
      const present = yield* warnOnFailure(
        Effect.tryPromise({
          try: () => bucket.head(sample),
          catch: (cause) =>
            new R2ReconcileError({ bucket: label, reason: `head failed: ${String(cause)}` }),
        }),
        "r2 reconcile aborted — live sample lookup in the bucket failed",
      );
      if (present === null) {
        return yield* fail(
          "the live sample is not an object in this bucket",
          "r2 reconcile aborted — the database's live sample is missing from the bucket (delete-nothing safeguard)",
        );
      }
      // The sample goes last and only there, so a lookup that loses the tail of
      // its input loses the sample too. Left in place as a candidate as well, a
      // copy earlier in the list would survive the loss and hide it.
      const lookup = [...candidates.filter((key) => key !== sample), sample];
      const named = yield* referenceRead(plan.named(lookup));
      if (!named.has(sample)) {
        return yield* fail(
          "the reference check did not name its live sample",
          "r2 reconcile aborted — the reference check failed its control",
        );
      }
      orphans = candidates.filter((key) => !named.has(key));
    }

    const capped = orphans.length > RECONCILE_DELETE_CAP;
    if (capped) {
      orphans = orphans.slice(0, RECONCILE_DELETE_CAP);
      yield* Effect.logWarning("r2 reconcile hit its per-run delete cap — next run continues", {
        bucket: label,
        cap: RECONCILE_DELETE_CAP,
      });
    }

    // Guard 4: the only delete. Best-effort; failures are logged and counted on
    // `cire.r2.objects.swept` and never fail the run.
    const reap =
      orphans.length > 0 ? yield* reapR2Objects(bucket, label, orphans) : { reaped: 0, failed: 0 };

    if (budget) {
      const lapStartedAt = state?.lapStartedAt ?? nowMs;
      let next: WalkState | undefined;
      if (capped || reap.failed > 0) {
        // Walk this stretch again next run: that retries any delete that failed
        // and reaches whatever the cap left.
        next = { after: state?.after ?? null, lapStartedAt };
      } else if (reachedEnd) {
        next = undefined;
      } else if (largestKey !== undefined) {
        next = { after: largestKey, lapStartedAt };
      } else {
        yield* Effect.logWarning(
          "r2 reconcile spent its listing budget without reaching an object — position unchanged",
          { bucket: label, listCalls },
        );
        next = state ?? { after: null, lapStartedAt };
      }
      // An unreadable stored position is always replaced or removed, so its
      // warning does not repeat on every run.
      if (unreadable || !sameState(state, next)) {
        yield* warnOnFailure(
          budget.position.write(next && JSON.stringify(next)),
          "r2 reconcile failed to save its position",
        );
      }
    }

    yield* Effect.logInfo("r2 reconcile complete", {
      bucket: label,
      examined,
      listCalls,
      candidates: candidates.length,
      deleted: orphans.length,
      capped,
      lapComplete: reachedEnd,
    });
    return orphans.length;
  }).pipe(
    // Each failure is logged above; this adds the one error count per run.
    Effect.tapError(() => Effect.sync(() => metricR2ObjectsSwept(label, "error"))),
  );
}
