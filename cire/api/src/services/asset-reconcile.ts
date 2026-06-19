import { events, weddingInviteCustomisations } from "@cire/db";
import { isNotNull } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricR2ObjectsSwept } from "../metrics";
import { reapR2Objects } from "./r2-cleanup";

/**
 * `cire-assets` orphan reconciliation (IB-S-L2 — the open `cire-assets` half).
 *
 * Invite images live in the `cire-assets` R2 bucket (binding `ASSETS`), keyed
 * `assets/<weddingId>/<slot>-<uuid>`. The keys are referenced by
 * `wedding_invite_customisations.hero_image_key`/`story_image_key` and
 * `events.event_image_key`. When a re-upload's (or remove's) BEST-EFFORT delete
 * of the SUPERSEDED object fails, that object is orphaned forever — nothing in
 * D1 references it anymore, and there is no R2 lifecycle rule. The retention
 * sweep deliberately never touches `cire-assets` (it keeps the live invite, so
 * those rows survive); this is the separate reconciliation that closes the gap.
 *
 * ───────────────────────────── DESTRUCTIVE-RISK ──────────────────────────────
 * This DELETES real wedding photos. A bug here is catastrophic (it would reap a
 * couple's live invite imagery). Every guard below exists to make "delete the
 * wrong thing" impossible rather than merely unlikely. Read them before editing.
 *
 *  1. ABORT-ON-UNCERTAINTY — the live set is the union of every hero/story key
 *     in `wedding_invite_customisations` and every `event_image_key` in
 *     `events`, across ALL weddings. If that read FAILS, or returns an EMPTY set
 *     while the bucket is non-empty (a strong signal the DB read is wrong / a
 *     half-applied migration / wrong binding), we ABORT and delete NOTHING.
 *     We never delete unless we can POSITIVELY confirm what is live.
 *
 *  2. GRACE PERIOD — an object is only a candidate if its R2 `uploaded`
 *     timestamp is older than {@link RECONCILE_GRACE_MS} (7 days). A freshly
 *     uploaded object whose DB-row write is momentarily lagging (or in flight)
 *     is therefore never reaped on the same day it was written.
 *
 *  3. PREFIX SCOPING — only keys under the `assets/` prefix are ever considered.
 *     Anything else in the bucket is ignored entirely (never listed-against,
 *     never deleted).
 *
 *  4. PER-RUN CAP + CHUNKING — `list()` is paginated via cursor; deletions are
 *     capped at {@link RECONCILE_DELETE_CAP} per run (logged if capped — the next
 *     run continues). Deletes are best-effort via {@link reapR2Objects} (logged,
 *     no PII, bounded `cire.r2.objects.swept` metric); a delete failure never
 *     aborts the run.
 *
 * Runs OFF the hot path — only from the Worker `scheduled()` cron handler.
 */

/** R2 key prefix that holds invite images. ONLY keys under this are touched. */
export const ASSETS_PREFIX = "assets/";

/**
 * Grace window: an object younger than this (by its R2 `uploaded` time) is never
 * a reconciliation candidate, so a just-uploaded object whose DB-row write is
 * lagging is never reaped. 7 days in milliseconds.
 */
export const RECONCILE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Max objects deleted per run. A run that would exceed this deletes the first
 * `cap` and logs that it was capped; the next scheduled run continues (the
 * orphans are stable, so they're caught next time). Bounds the Worker
 * subrequest/CPU budget and the blast radius of any single run.
 */
export const RECONCILE_DELETE_CAP = 500;

/** Max objects requested per `list()` page (R2's documented ceiling is 1000). */
const LIST_PAGE_SIZE = 1000;

/**
 * Minimal listable + deletable R2 surface. Cloudflare's `R2Bucket` satisfies
 * this structurally; the in-memory test stub implements just these. `list`
 * returns the cursor-paginated object listing; `delete` is fed to
 * {@link reapR2Objects} (which feature-detects the array form).
 */
export interface ReconcilableBucket {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: ReadonlyArray<{ key: string; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<unknown> | unknown;
}

export class AssetReconcileError extends Data.TaggedError("AssetReconcileError")<{
  op: "reconcile";
  reason: string;
}> {}

/**
 * Build the set of R2 keys that ANY live DB row references — across ALL
 * weddings. The reconciliation only ever deletes keys NOT in this set, so this
 * read is the single source of truth for "what is live". It is also the
 * abort-on-uncertainty signal: a throw here (caught by the caller) aborts the
 * whole run.
 */
function loadReferencedKeys(): Effect.Effect<Set<string>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    // hero/story keys (one customisation row per wedding). Only non-null.
    const custRows = yield* dbQuery(() =>
      db
        .select({
          hero: weddingInviteCustomisations.heroImageKey,
          story: weddingInviteCustomisations.storyImageKey,
        })
        .from(weddingInviteCustomisations)
        .all(),
    );

    // event image keys (one optional per event). Filter to non-null in SQL.
    const eventRows = yield* dbQuery(() =>
      db
        .select({ key: events.eventImageKey })
        .from(events)
        .where(isNotNull(events.eventImageKey))
        .all(),
    );

    const referenced = new Set<string>();
    for (const r of custRows) {
      if (r.hero) referenced.add(r.hero);
      if (r.story) referenced.add(r.story);
    }
    for (const r of eventRows) {
      if (r.key) referenced.add(r.key);
    }
    return referenced;
  });
}

export const assetReconcileService = {
  /**
   * Sweep the `cire-assets` bucket and best-effort delete objects under
   * `assets/` that are (a) referenced by NO live DB row and (b) older than the
   * grace window. See the module docstring for the full guard set. Returns the
   * number of objects deleted (the log/metric subject); 0 on an abort.
   *
   * @param bucket the `ASSETS` binding. Absent ⇒ no-op (nothing to reconcile).
   * @param now    injected clock for the grace-window comparison (tests).
   */
  reconcileOrphans(
    bucket: ReconcilableBucket | undefined,
    now: Date = new Date(),
  ): Effect.Effect<number, AssetReconcileError, DbService> {
    return Effect.gen(function* () {
      // No binding in this deployment (local dev / misconfig) — nothing to do.
      if (!bucket) {
        yield* Effect.logInfo("asset reconcile skipped — ASSETS binding absent");
        return 0;
      }

      // ── GUARD 1a: build the live set; a READ FAILURE aborts (delete nothing). ──
      const referenced = yield* loadReferencedKeys().pipe(
        Effect.catchAllDefect((cause) =>
          Effect.fail(new AssetReconcileError({ op: "reconcile", reason: String(cause) })),
        ),
        Effect.tapError((err) =>
          Effect.logWarning("asset reconcile aborted — referenced-key read failed", {
            reason: err.reason,
          }),
        ),
      );

      const cutoff = now.getTime() - RECONCILE_GRACE_MS;

      // Walk the bucket page by page, collecting orphan candidates. We track
      // whether the bucket has ANY object under the prefix so the empty-set
      // abort guard can distinguish "DB read is wrong" from "nothing uploaded".
      const orphans: string[] = [];
      let bucketHasPrefixedObject = false;
      let capped = false;

      // Pagination loop — Effect has no `while`, so recurse over the cursor.
      const listPage = (nextCursor: string | undefined): Effect.Effect<void, AssetReconcileError> =>
        Effect.gen(function* () {
          if (orphans.length >= RECONCILE_DELETE_CAP) {
            capped = true;
            return;
          }
          const page = yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(
                bucket.list({
                  prefix: ASSETS_PREFIX,
                  cursor: nextCursor,
                  limit: LIST_PAGE_SIZE,
                }),
              ),
            catch: (cause) =>
              new AssetReconcileError({ op: "reconcile", reason: `list failed: ${String(cause)}` }),
          });

          for (const obj of page.objects) {
            // GUARD 3: prefix scoping — defence-in-depth (we asked for the
            // prefix, but never trust the listing to honour it).
            if (!obj.key.startsWith(ASSETS_PREFIX)) continue;
            bucketHasPrefixedObject = true;
            // Live ⇒ never a candidate.
            if (referenced.has(obj.key)) continue;
            // GUARD 2: grace period — too-new objects are skipped.
            if (obj.uploaded.getTime() >= cutoff) continue;
            orphans.push(obj.key);
            if (orphans.length >= RECONCILE_DELETE_CAP) {
              capped = true;
              return;
            }
          }

          if (page.truncated && page.cursor) {
            yield* listPage(page.cursor);
          }
        });

      yield* listPage(undefined).pipe(
        Effect.tapError((err) =>
          Effect.logWarning("asset reconcile aborted — bucket list failed", {
            reason: err.reason,
          }),
        ),
      );

      // ── GUARD 1b: EMPTY live set + a NON-EMPTY bucket ⇒ abort (delete nothing). ──
      // An empty referenced set while objects exist is a strong signal the DB
      // read is wrong (half-applied migration, wrong binding, query bug). Never
      // delete on that signal — the cost of a wrong delete is a couple's photos.
      if (referenced.size === 0 && bucketHasPrefixedObject) {
        yield* Effect.logWarning(
          "asset reconcile aborted — referenced-key set empty while bucket non-empty (delete-nothing safeguard)",
          { orphanCandidates: orphans.length },
        );
        return 0;
      }

      if (orphans.length === 0) {
        yield* Effect.logInfo("asset reconcile complete — no orphans", {
          referenced: referenced.size,
        });
        return 0;
      }

      if (capped) {
        yield* Effect.logWarning("asset reconcile hit per-run delete cap — next run continues", {
          cap: RECONCILE_DELETE_CAP,
        });
      }

      // GUARD 4: best-effort, bounded deletes. A failure is logged + counted on
      // `cire.r2.objects.swept` (bucket=assets) but never aborts the run.
      yield* reapR2Objects(bucket, "assets", orphans);

      yield* Effect.logInfo("asset reconcile complete", {
        referenced: referenced.size,
        deleted: orphans.length,
        capped,
      });
      return orphans.length;
    }).pipe(
      // A list/abort failure already logged above; surface a single error metric
      // and re-raise as the typed error so the cron handler's catchAll logs it.
      Effect.tapError(() => Effect.sync(() => metricR2ObjectsSwept("assets", "error"))),
      Effect.withSpan("cire.assets.reconcileOrphans"),
    );
  },
};
