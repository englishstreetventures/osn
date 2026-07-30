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
 */

import { imports, vendorClaims } from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { and, eq, lt, lte } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService } from "../db";
import { metricStalePreviewsSwept, metricVendorClaimsSwept } from "../metrics";
import type { DeletableBucket } from "./r2-cleanup";
import { reapR2Objects } from "./r2-cleanup";

export class MaintenanceSweepError extends Data.TaggedError("MaintenanceSweepError")<{
  op: "vendor_claims" | "stale_previews";
  reason: string;
}> {}

/**
 * A preview never applied within this window is abandoned: the organiser's
 * portal flow previews and applies in one sitting, so 7 days is generous while
 * still bounding how long an orphaned sheet upload (guest PII) can linger.
 */
export const PREVIEW_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
};
