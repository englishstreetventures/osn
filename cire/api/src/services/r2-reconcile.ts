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
 *  5. HOLD ON A HALVING — the reference check also reports how many live rows
 *     name a key under the prefix, from the same statement as the named set,
 *     and a walk with a budget keeps that count with its position. A run whose
 *     count is less than half of the stored one deletes nothing, keeps the
 *     stored count, and alerts the operator. Later runs compare with that same
 *     count, so the hold lasts until the rows recover to at least half of it,
 *     an operator removes the position object, or
 *     {@link RECONCILE_HOLD_RUNS} runs have held — after which the next such
 *     run accepts the lower count, says so, and deletes. A run with no stored
 *     count to compare with (the first, or after an unreadable position) is
 *     not held, and stores one.
 *  6. STOP OBJECT — before anything else a run looks for
 *     {@link RECONCILE_STOP_KEY} in its bucket; while it is there the run
 *     deletes nothing, touches no position and alerts the operator with its
 *     age. Only an operator writes it, and no deploy touches it.
 *
 * Every delete batch logs a warning and records its size on
 * `cire.r2.reconcile.batch.size`. `CIRE_R2_RECONCILE_DISABLED` (see
 * {@link reconcileDisabled}) keeps both reconcilers out of `scheduled` in
 * `index.ts` for a whole tier, without touching the other cron jobs.
 *
 * A walk with a {@link ListBudget} lists a bounded number of objects a run and
 * keeps its place between runs, so a bucket larger than the budget is covered
 * over several runs — a "lap". The position only chooses where a walk starts;
 * it cannot make an object a candidate.
 *
 * Runs off the hot path only, from the Worker's `scheduled` cron handler.
 */
import { Data, Effect, Option, Schema } from "effect";

import { metricR2ObjectsSwept, metricR2ReconcileBatch } from "../metrics";
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

/**
 * While an object is at this key the bucket's reconciler deletes nothing. It
 * lies outside every walked prefix (`imports/`, `assets/`), in the `reconcile/`
 * area beside the position objects, and nothing in the Worker writes it.
 */
export const RECONCILE_STOP_KEY = "reconcile/stop";

/**
 * Most runs a hold on a halving lasts: 7, a week of daily runs. A stopped or
 * disabled run does not count, so the operator's stop never uses it up.
 */
export const RECONCILE_HOLD_RUNS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most objects one `list()` page may request — R2's documented ceiling. */
const LIST_PAGE_SIZE = 1000;

/**
 * Listable and deletable R2. Cloudflare's `R2Bucket` satisfies this
 * structurally; the delete half is exactly {@link DeletableBucket}, because the
 * bucket goes straight to {@link reapR2Objects}.
 */
export interface ReconcilableBucket extends DeletableBucket {
  head(key: string): Promise<{ key: string; uploaded: Date } | null>;
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

/**
 * What a budgeted walk keeps between runs: where the walk stands (absent
 * between laps) and how many referencing rows the last run that read them
 * counted (absent until one has).
 */
interface ReconcileState {
  readonly walk: WalkState | undefined;
  readonly referenced: number | undefined;
  /** Runs held against `referenced` so far, 1 to {@link RECONCILE_HOLD_RUNS}; absent: not held. */
  readonly heldRuns: number | undefined;
}

/** What a reconciler tells the operator, by email from the cron. */
export type ReconcileAlert =
  | {
      readonly kind: "held";
      readonly bucket: R2BucketLabel;
      readonly referencingRows: number;
      readonly previousRows: number;
      readonly heldRuns: number;
      readonly runsLeft: number;
    }
  | {
      readonly kind: "released";
      readonly bucket: R2BucketLabel;
      readonly referencingRows: number;
      readonly previousRows: number;
    }
  | { readonly kind: "stopped"; readonly bucket: R2BucketLabel; readonly stoppedDays: number };

/** Storage for a {@link ReconcileState}, as text. Either call failing fails the run. */
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

/** What the reference check answers about the keys it was asked. */
export interface NamedKeys {
  /**
   * Every one of the asked keys that a live row names, compared as exact
   * strings, and none of them that no live row names; it may hold other keys.
   */
  readonly named: ReadonlySet<string>;
  /**
   * How many live rows name a key under the prefix, read in the same statement
   * as {@link NamedKeys.named} so the two describe one moment.
   */
  readonly referencingRows: number;
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
   * Which of `keys` live rows name, and how many live rows there are. Called
   * once per run, after the walk. A defect aborts the run.
   */
  readonly named: (keys: ReadonlyArray<string>) => Effect.Effect<NamedKeys, never, R>;
  /**
   * Absent: the whole prefix is walked every run, and with nowhere to keep a
   * count the hold on a halving compares nothing.
   */
  readonly budget?: ListBudget;
  /**
   * Told when a run is stopped, held, or ends a hold, before anything is
   * written. It should not fail; a failure or defect is logged and the run
   * goes on.
   */
  readonly alertOperator?: (alert: ReconcileAlert) => Effect.Effect<void, never>;
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

const StoredState = Schema.Struct({
  after: Schema.optional(Schema.NullOr(Schema.String)),
  lapStartedAt: Schema.optional(Schema.Number),
  referenced: Schema.optional(Schema.Number),
  heldRuns: Schema.optional(Schema.Number),
});

/** A count of rows: a whole number from zero up that a double holds exactly. */
const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/**
 * The stored state if it is one a walk of `prefix` could have written by
 * `now`; undefined otherwise. The walk's two fields come together or not at
 * all, an object holds at least one of the walk and the count, and held runs
 * come only with a count.
 */
function parseState(text: string, prefix: string, now: number): ReconcileState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Option.match(Schema.decodeUnknownOption(StoredState)(parsed), {
    onNone: () => undefined,
    onSome: ({ after, lapStartedAt, referenced, heldRuns }): ReconcileState | undefined => {
      if (referenced !== undefined && !isCount(referenced)) return undefined;
      if (
        heldRuns !== undefined &&
        (referenced === undefined ||
          !Number.isSafeInteger(heldRuns) ||
          heldRuns < 1 ||
          heldRuns > RECONCILE_HOLD_RUNS)
      ) {
        return undefined;
      }
      if (after === undefined && lapStartedAt === undefined) {
        // Nothing to keep is written as no object, never as an empty one.
        return referenced === undefined ? undefined : { walk: undefined, referenced, heldRuns };
      }
      if (after === undefined || lapStartedAt === undefined) return undefined;
      const walkable =
        (after === null || after.startsWith(prefix)) &&
        Number.isFinite(lapStartedAt) &&
        lapStartedAt <= now;
      return walkable ? { walk: { after, lapStartedAt }, referenced, heldRuns } : undefined;
    },
  });
}

/** The stored text for `state`; undefined when there is nothing to keep. */
function stateText(state: ReconcileState): string | undefined {
  if (state.walk === undefined && state.referenced === undefined) return undefined;
  return JSON.stringify({
    ...state.walk,
    referenced: state.referenced,
    heldRuns: state.heldRuns,
  });
}

/**
 * Whether the cron should leave both reconcilers off, from the
 * `CIRE_R2_RECONCILE_DISABLED` binding. Only an absent value, boolean `false`,
 * or text that reads `false` once trimmed and lower-cased keeps them on; any
 * other value, a typo included, turns them off, since the flag exists to stop
 * deletion. The binding is not always a string: wrangler passes a TOML or
 * dashboard value through with its own type.
 */
export function reconcileDisabled(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  return typeof value !== "string" || value.trim().toLowerCase() !== "false";
}

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

  // An alert is a courtesy to the run, never a step it depends on.
  const alert = (event: ReconcileAlert) =>
    plan.alertOperator
      ? plan.alertOperator(event).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("r2 reconcile operator alert failed", {
              bucket: label,
              kind: event.kind,
            }),
          ),
        )
      : Effect.void;

  return Effect.gen(function* () {
    if (!bucket) {
      yield* Effect.logInfo("r2 reconcile skipped — bucket binding absent", { bucket: label });
      return 0;
    }

    // Guard 6: an operator's stop, before any other read.
    const stop = yield* warnOnFailure(
      Effect.tryPromise({
        try: () => bucket.head(RECONCILE_STOP_KEY),
        catch: (cause) =>
          new R2ReconcileError({ bucket: label, reason: `stop check failed: ${String(cause)}` }),
      }),
      "r2 reconcile aborted — the stop object could not be checked",
    );
    if (stop !== null) {
      const stoppedDays = Math.max(0, Math.floor((nowMs - stop.uploaded.getTime()) / DAY_MS));
      yield* Effect.logWarning("r2 reconcile stopped — reconcile/stop is in the bucket", {
        bucket: label,
        stoppedDays,
      });
      yield* alert({ kind: "stopped", bucket: label, stoppedDays });
      return 0;
    }

    let stored: ReconcileState | undefined;
    let unreadable = false;
    if (budget) {
      const text = yield* warnOnFailure(
        budget.position.read,
        "r2 reconcile aborted — position read failed",
      );
      stored = text === undefined ? undefined : parseState(text, prefix, nowMs);
      unreadable = text !== undefined && stored === undefined;
      if (unreadable) {
        yield* Effect.logWarning("r2 reconcile position unreadable — starting a new lap", {
          bucket: label,
        });
      }
    }
    const state = stored?.walk;
    if (budget) {
      if (state && nowMs - state.lapStartedAt > LAP_WARNING_MS) {
        yield* Effect.logWarning(
          "r2 reconcile lap has run past its warning window — the listing budget no longer covers the bucket often enough",
          { bucket: label, lapDays: Math.floor((nowMs - state.lapStartedAt) / DAY_MS) },
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
    let referencingRows: number | undefined;
    let held = false;
    // What the stored count and held runs become; undefined keeps what is stored.
    let nextCount: { referenced: number; heldRuns: number | undefined } | undefined;
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
      const answer = yield* referenceRead(plan.named(lookup));
      if (!answer.named.has(sample)) {
        return yield* fail(
          "the reference check did not name its live sample",
          "r2 reconcile aborted — the reference check failed its control",
        );
      }
      if (!isCount(answer.referencingRows)) {
        return yield* fail(
          "referencing-row count is not a count",
          "r2 reconcile aborted — the reference check returned no usable row count",
        );
      }
      referencingRows = answer.referencingRows;
      const unnamed = candidates.filter((key) => !answer.named.has(key));
      // Guard 5: rows fell by more than half since the stored count.
      const previous = stored?.referenced;
      const heldRuns = (stored?.heldRuns ?? 0) + 1;
      if (previous !== undefined && referencingRows * 2 < previous) {
        if (heldRuns <= RECONCILE_HOLD_RUNS) {
          held = true;
          nextCount = { referenced: previous, heldRuns };
          yield* Effect.logWarning(
            "r2 reconcile held — referencing rows fell by more than half (delete-nothing safeguard)",
            {
              bucket: label,
              referencingRows,
              previousRows: previous,
              heldRuns,
              orphans: unnamed.length,
            },
          );
          yield* alert({
            kind: "held",
            bucket: label,
            referencingRows,
            previousRows: previous,
            heldRuns,
            runsLeft: RECONCILE_HOLD_RUNS - heldRuns,
          });
        } else {
          yield* Effect.logWarning(
            "r2 reconcile hold ended — accepting the lower referencing-row count",
            { bucket: label, referencingRows, previousRows: previous, heldRuns: heldRuns - 1 },
          );
          yield* alert({
            kind: "released",
            bucket: label,
            referencingRows,
            previousRows: previous,
          });
        }
      }
      if (!held) {
        orphans = unnamed;
        nextCount = { referenced: referencingRows, heldRuns: undefined };
      }
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
    // `cire.r2.objects.swept` and never fail the run. Every batch is announced
    // first, so the warning stands even if the run dies part-way.
    let reap = { reaped: 0, failed: 0 };
    if (orphans.length > 0) {
      yield* Effect.logWarning("r2 reconcile deleting orphan objects", {
        bucket: label,
        objects: orphans.length,
        capped,
        referencingRows,
      });
      yield* Effect.sync(() => metricR2ReconcileBatch(label, orphans.length));
      reap = yield* reapR2Objects(bucket, label, orphans);
    }

    if (budget) {
      const lapStartedAt = state?.lapStartedAt ?? nowMs;
      let walk: WalkState | undefined;
      if (held) {
        // Nothing was deleted, so the next run walks this stretch again.
        walk = state;
      } else if (capped || reap.failed > 0) {
        // Walk this stretch again next run: that retries any delete that failed
        // and reaches whatever the cap left.
        walk = { after: state?.after ?? null, lapStartedAt };
      } else if (reachedEnd) {
        walk = undefined;
      } else if (largestKey !== undefined) {
        walk = { after: largestKey, lapStartedAt };
      } else {
        yield* Effect.logWarning(
          "r2 reconcile spent its listing budget without reaching an object — position unchanged",
          { bucket: label, listCalls },
        );
        walk = state ?? { after: null, lapStartedAt };
      }
      // A held run keeps the count from before the drop and adds a held run;
      // any other run that read a count stores it; one that read none keeps
      // what is stored.
      const next = stateText({
        walk,
        referenced: nextCount ? nextCount.referenced : stored?.referenced,
        heldRuns: nextCount ? nextCount.heldRuns : stored?.heldRuns,
      });
      const before = stored && stateText(stored);
      // An unreadable stored position is always replaced or removed, so its
      // warning does not repeat on every run.
      if (unreadable || next !== before) {
        yield* warnOnFailure(
          budget.position.write(next),
          "r2 reconcile failed to save its position",
        );
      }
    }

    yield* Effect.logInfo("r2 reconcile complete", {
      bucket: label,
      examined,
      listCalls,
      candidates: candidates.length,
      referencingRows,
      held,
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
