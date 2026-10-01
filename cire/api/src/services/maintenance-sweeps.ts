/**
 * Small scheduled sweeps for tables whose rows expire but nothing deleted
 * (data-layer review 2026-07-30). Both run from the Worker's daily cron
 * alongside the session + retention sweeps, each in its own `waitUntil`.
 *
 *  - `vendor_claims`: claim tokens carry `expires_at` (7-day TTL) and
 *    `consumed_at`, but no code path ever deleted them — expired and consumed
 *    tokens accumulated forever. Rows are deleted once PAST EXPIRY (consumed
 *    rows keep their audit value until then; they expire like any other).
 *    Token hashes are not sensitive at rest (SHA-256 of 256-bit random), so
 *    this is hygiene, not a security fix.
 *
 *  - `imports` rows stuck in `status='preview'`: an organiser who uploads a
 *    sheet and abandons the preview leaves the row + BOTH uploaded CSVs
 *    (guest PII, in `cire-sheets`) alive until the wedding ages out of the
 *    1-year retention sweep. Previews older than the staleness window are
 *    deleted and their sheet objects reaped — collect-keys-then-delete-then-
 *    reap, the retention sweep's ordering. Applied/reverted rows are never
 *    touched (they are the change history + revert source).
 *
 *  - Soft-deleted weddings past their restore window: hard-deleted, with every
 *    child row by FK cascade and every R2 object their rows name. See
 *    `purgeDeletedWeddings`.
 */

import {
  events,
  imports,
  registryContributions,
  registryItems,
  vendorClaims,
  weddingInviteCustomisations,
  weddings,
  weddingUpgradePurchases,
} from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { and, asc, count, eq, isNotNull, lt, lte, not, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitBatchResults, DbService, outerColumn } from "../db";
import { epochSeconds, RESTORE_WINDOW_S } from "../db/live-wedding";
import {
  metricStalePreviewsSwept,
  metricVendorClaimsSwept,
  metricWeddingPurgeBacklog,
  metricWeddingPurged,
} from "../metrics";
import type { DeletableBucket } from "./r2-cleanup";
import { reapR2Objects } from "./r2-cleanup";
import { changeClaimLive } from "./wedding-lifecycle";

export class MaintenanceSweepError extends Data.TaggedError("MaintenanceSweepError")<{
  op: "vendor_claims" | "stale_previews" | "purge_deleted_weddings";
  reason: string;
}> {}

/**
 * Deleted weddings one daily run hard-deletes, oldest first. A bounded
 * estimate, not a measurement: every cron job shares one invocation's D1
 * query ceiling, and a purge's cascade is the largest single write any job
 * makes. A run that leaves more due than this logs it and records the backlog.
 */
export const MAX_PURGES_PER_RUN = 3;

/**
 * How long a pending upgrade purchase or gift holds a past-window wedding back
 * from the purge, from its `created_at` (SECONDS). No new pending row can be
 * started on a deleted wedding later than one request that passed its gate
 * just before the delete, and Stripe closes that request's session within a
 * day, so this always ends.
 */
export const PURGE_PENDING_HOLD_S = 14 * 24 * 60 * 60;

/**
 * Why a past-window wedding is not purged yet: money that can still move, or a
 * change still writing. `wedding` is a bound id or the outer row's id
 * (`outerColumn`); `nowS` is SECONDS, `nowMs` MILLISECONDS. The statement must
 * read `weddings` as its own table, for the change-claim half.
 *
 * A `disputed` gift holds however old it is: a dispute reaches the platform's
 * balance, and its close must find the row.
 */
const purgeHeld = (wedding: SQL | string, nowS: number, nowMs: number): SQL =>
  sql`(EXISTS (SELECT 1 FROM ${weddingUpgradePurchases} WHERE ${weddingUpgradePurchases.weddingId} = ${wedding} AND ${weddingUpgradePurchases.status} = 'pending' AND ${weddingUpgradePurchases.createdAt} > ${nowS - PURGE_PENDING_HOLD_S}) OR EXISTS (SELECT 1 FROM ${registryContributions} WHERE ${registryContributions.weddingId} = ${wedding} AND (${registryContributions.status} = 'disputed' OR (${registryContributions.status} = 'pending' AND ${registryContributions.createdAt} > ${nowS - PURGE_PENDING_HOLD_S}))) OR ${changeClaimLive(nowMs)})`;

export interface PurgeRunResult {
  purged: number;
  held: number;
  errors: number;
  /** Due, unheld weddings this run's cap left for a later one. */
  backlog: number;
}

type KeyRow = Record<string, string | null>;

/** Every non-empty key in the rows, in column order. */
const keysOf = (rows: readonly KeyRow[]): string[] =>
  rows.flatMap((row) => Object.values(row).filter((k): k is string => !!k));

/**
 * A preview never applied within this window is abandoned: the organiser's
 * portal flow previews and applies in one sitting, so 7 days is generous while
 * still bounding how long an orphaned sheet upload (guest PII) can linger.
 */
export const PREVIEW_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Purge one past-window wedding: see `purgeDeletedWeddings`. `"held"` when
 * the guarded delete matched nothing — restored, or a hold appeared, after the
 * candidate read.
 */
function purgeOne(
  candidate: { id: string; deletedBy: string | null },
  nowS: number,
  nowMs: number,
  cutoffS: number,
  reapTo: { sheets?: DeletableBucket; assets?: DeletableBucket },
): Effect.Effect<"ok" | "held", MaintenanceSweepError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const weddingId = candidate.id;
    // Four single-table reads, each with its key columns side by side and
    // unpivoted below. NOT one compound SELECT with a term per column: D1
    // allows at most 5 terms in a `UNION`/`UNION ALL` (bun:sqlite allows
    // 500), so a term per key column fails every purge on D1 while every
    // local test passes.
    const results = yield* Effect.tryPromise({
      try: () =>
        commitBatchResults(db, [
          db
            .select({
              events: imports.eventsR2Key,
              guests: imports.guestsR2Key,
              beforeEvents: imports.beforeEventsR2Key,
              beforeGuests: imports.beforeGuestsR2Key,
            })
            .from(imports)
            .where(eq(imports.weddingId, weddingId)),
          db
            .select({
              hero: weddingInviteCustomisations.heroImageKey,
              story: weddingInviteCustomisations.storyImageKey,
              footer: weddingInviteCustomisations.footerImageKey,
            })
            .from(weddingInviteCustomisations)
            .where(eq(weddingInviteCustomisations.weddingId, weddingId)),
          db
            .select({ key: events.eventImageKey })
            .from(events)
            .where(and(eq(events.weddingId, weddingId), isNotNull(events.eventImageKey))),
          db
            .select({ key: registryItems.imageKey })
            .from(registryItems)
            .where(and(eq(registryItems.weddingId, weddingId), isNotNull(registryItems.imageKey))),
          db
            .delete(weddings)
            .where(
              and(
                eq(weddings.id, weddingId),
                isNotNull(weddings.deletedAt),
                sql`${weddings.deletedAt} <= ${cutoffS}`,
                not(purgeHeld(weddingId, nowS, nowMs)),
              ),
            )
            .returning({ id: weddings.id }),
        ]),
      catch: (e) => new MaintenanceSweepError({ op: "purge_deleted_weddings", reason: String(e) }),
    });

    const [deleted] = results[4] as readonly { id: string }[];
    // Restored, or a hold appeared, between the candidate read and here.
    if (!deleted) return "held" as const;

    const sheetKeys = keysOf(results[0] as readonly KeyRow[]);
    const assetKeys = [
      ...keysOf(results[1] as readonly KeyRow[]),
      ...keysOf(results[2] as readonly KeyRow[]),
      ...keysOf(results[3] as readonly KeyRow[]),
    ];
    yield* reapR2Objects(reapTo.sheets, "sheets", sheetKeys);
    yield* reapR2Objects(reapTo.assets, "assets", assetKeys);
    // The only record left once the rows are gone: ids and counts, no names.
    yield* Effect.logInfo("wedding purged", {
      weddingId,
      deletedByProfileId: candidate.deletedBy,
      sheetKeys: sheetKeys.length,
      assetKeys: assetKeys.length,
    });
    return "ok" as const;
  }).pipe(Effect.withSpan("cire.wedding.purge"));
}

export const maintenanceSweeps = {
  /** Delete every vendor-claim token past its expiry. Returns rows deleted. */
  sweepExpiredVendorClaims(
    now: Date = new Date(),
  ): Effect.Effect<number, MaintenanceSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(db.delete(vendorClaims).where(lte(vendorClaims.expiresAt, now)).run()),
        catch: (e) => new MaintenanceSweepError({ op: "vendor_claims", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("vendor-claim sweep failed", { reason: err.reason }),
        ),
      );
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricVendorClaimsSwept("ok", deleted));
      yield* Effect.logInfo("vendor-claim sweep complete", { deleted });
      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricVendorClaimsSwept("error"))),
      Effect.withSpan("cire.maintenance.sweepExpiredVendorClaims"),
    );
  },

  /**
   * Delete `preview` change rows older than the staleness window and reap the
   * uploaded-sheet R2 objects they reference. Returns rows deleted.
   */
  sweepStalePreviews(
    now: Date = new Date(),
    buckets: { sheets?: DeletableBucket } = {},
  ): Effect.Effect<number, MaintenanceSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const cutoff = now.getTime() - PREVIEW_STALE_AFTER_MS;

      // Collect the sheet keys BEFORE deleting — once the rows are gone the
      // keys are unrecoverable (D1 never reaches into R2).
      const stale = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .select({
                id: imports.id,
                eventsKey: imports.eventsR2Key,
                guestsKey: imports.guestsR2Key,
              })
              .from(imports)
              .where(and(eq(imports.status, "preview"), lt(imports.uploadedAt, cutoff)))
              .all(),
          ),
        catch: (e) => new MaintenanceSweepError({ op: "stale_previews", reason: String(e) }),
      });
      if (stale.length === 0) {
        yield* Effect.sync(() => metricStalePreviewsSwept("ok", 0));
        return 0;
      }
      const sheetKeys = stale.flatMap((r) => [r.eventsKey, r.guestsKey]);

      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .delete(imports)
              .where(and(eq(imports.status, "preview"), lt(imports.uploadedAt, cutoff)))
              .run(),
          ),
        catch: (e) => new MaintenanceSweepError({ op: "stale_previews", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("stale-preview sweep failed", { reason: err.reason }),
        ),
      );
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricStalePreviewsSwept("ok", deleted));
      yield* Effect.logInfo("stale-preview sweep complete", { deleted });

      // Best-effort, post-delete (same ordering as the retention sweep): a
      // reap failure can't leave a live row pointing at a deleted object.
      yield* reapR2Objects(buckets.sheets, "sheets", sheetKeys);

      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricStalePreviewsSwept("error"))),
      Effect.withSpan("cire.maintenance.sweepStalePreviews"),
    );
  },

  /**
   * Hard-delete soft-deleted weddings whose restore window has passed, at most
   * {@link MAX_PURGES_PER_RUN} a run, oldest first, skipping any {@link purgeHeld}
   * holds so a held wedding never blocks the rest of the queue.
   *
   * Per wedding, ONE batch: the R2 keys its rows name, then the guarded
   * delete. A D1 batch is one transaction, so the keys read are exactly the
   * rows deleted, and the delete re-checks the window (a restore that landed
   * after the candidate read wins) and the holds (a webhook that landed after
   * it wins). FK cascades take every child row; `platform_sales` has no FK and
   * survives. The R2 reap runs only after the delete returned its row, and is
   * best-effort: a failure is logged and counted, never a reason to fail the
   * sweep — the rows are already gone.
   *
   * A failure on one wedding is logged and counted, and the run goes on.
   */
  purgeDeletedWeddings(
    now: Date = new Date(),
    buckets: { sheets?: DeletableBucket; assets?: DeletableBucket } = {},
  ): Effect.Effect<PurgeRunResult, MaintenanceSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const nowS = epochSeconds(now);
      const nowMs = now.getTime();
      const cutoffS = nowS - RESTORE_WINDOW_S;
      const pastWindow = and(
        isNotNull(weddings.deletedAt),
        sql`${weddings.deletedAt} <= ${cutoffS}`,
      );
      const heldHere = purgeHeld(outerColumn(weddings.id), nowS, nowMs);
      const failRead = (e: unknown) =>
        new MaintenanceSweepError({ op: "purge_deleted_weddings", reason: String(e) });

      // Two reads, both on the partial index: how many are due and held, and
      // the first few that are not held. Neither needs the other's answer, so
      // they go in one batch: one round trip, the run with nothing due included.
      const [totalRows, candidates] = yield* Effect.tryPromise({
        try: async () => {
          const [totalsRead, candidatesRead] = await commitBatchResults(db, [
            db
              .select({
                due: count(),
                held: sql<number>`coalesce(sum(CASE WHEN ${heldHere} THEN 1 ELSE 0 END), 0)`,
              })
              .from(weddings)
              .where(pastWindow),
            db
              .select({ id: weddings.id, deletedBy: weddings.deletedByOsnProfileId })
              .from(weddings)
              .where(and(pastWindow, not(heldHere)))
              .orderBy(asc(weddings.deletedAt))
              .limit(MAX_PURGES_PER_RUN),
          ]);
          return [
            totalsRead as readonly { due: number; held: number }[],
            candidatesRead as readonly { id: string; deletedBy: string | null }[],
          ] as const;
        },
        catch: failRead,
      });
      const [totals] = totalRows;
      const due = Number(totals?.due ?? 0);
      let held = Number(totals?.held ?? 0);
      const unheld = due - held;
      if (unheld > MAX_PURGES_PER_RUN) {
        // Not an error: the next run takes the remainder. Logged so a backlog
        // that never drains is visible rather than silent.
        yield* Effect.logInfo("wedding purge hit its per-run cap", {
          cap: MAX_PURGES_PER_RUN,
          due: unheld,
        });
      }

      let purged = 0;
      let errors = 0;
      for (const candidate of candidates) {
        const outcome = yield* purgeOne(candidate, nowS, nowMs, cutoffS, buckets).pipe(
          Effect.catch((err) =>
            Effect.logError("wedding purge failed", {
              weddingId: candidate.id,
              reason: err.reason,
            }).pipe(Effect.as("error" as const)),
          ),
        );
        if (outcome === "ok") purged += 1;
        else if (outcome === "held") held += 1;
        else errors += 1;
      }

      const backlog = Math.max(0, unheld - candidates.length);
      yield* Effect.sync(() => {
        metricWeddingPurged("ok", purged);
        metricWeddingPurged("held", held);
        metricWeddingPurged("error", errors);
        metricWeddingPurgeBacklog(backlog);
      });
      yield* Effect.logInfo("wedding purge sweep complete", { purged, held, errors, backlog });
      return { purged, held, errors, backlog };
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricWeddingPurged("error", 1))),
      Effect.withSpan("cire.maintenance.purgeDeletedWeddings"),
    );
  },
};
