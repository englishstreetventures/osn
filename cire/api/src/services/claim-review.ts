/**
 * The app-side half of vendor claim review. A redeemed claim waits on the
 * listing (`directory_vendors.review_*`) until an operator confirms or rejects
 * it with `scripts/cire-vendor-claim-review.ts`, which runs SQL against D1 and
 * so cannot run app code. Two things therefore happen here, on the daily cron:
 *
 *  - Hand-off. A confirm stamps `handoff_due_at`. The sweep picks those
 *    listings, clears the stamp with a compare-and-swap so only one runner
 *    takes each, then flushes the enquiries couples sent while the listing was
 *    unclaimed (`flushBufferedEnquiries`). Enquiries sent after the confirm go
 *    straight to the vendor, so only the buffered ones wait for the cron.
 *  - Reminder. It counts the claims still waiting and logs a warning when any
 *    are, so an operator reading Workers Logs sees them daily.
 *
 * Each flush costs two zap-api calls per buffered enquiry, and the cron's one
 * invocation shares a 50-external-subrequest ceiling on the Free plan with the
 * other jobs (`wiki/shared/free-tier-limits.md`). `HANDOFFS_PER_RUN` bounds the
 * listings taken per run; the rest wait for the next day.
 */
import { directoryVendors } from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { Data, Effect, Exit } from "effect";

import { DbService, dbQuery } from "../db";
import { metricVendorClaimReview } from "../metrics";
import type { FlushBufferedInput } from "./enquiries";

export class ClaimReviewSweepError extends Data.TaggedError("ClaimReviewSweepError")<{
  reason: string;
}> {}

/** Listings handed off per cron run. */
export const HANDOFFS_PER_RUN = 5;

/**
 * Flushes one confirmed listing's buffered enquiries. Null when the vendor-chat
 * feature is off: the sweep then leaves `handoff_due_at` set, so the hand-off
 * runs on the first day zap is configured instead of being lost.
 */
export type HandoffFlush =
  | ((input: FlushBufferedInput) => Effect.Effect<void, never, DbService>)
  | null;

export interface ClaimReviewSweepResult {
  handedOff: number;
  pending: number;
}

export const claimReviewService = {
  sweep(
    flush: HandoffFlush,
    limit: number = HANDOFFS_PER_RUN,
  ): Effect.Effect<ClaimReviewSweepResult, ClaimReviewSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [due, [counted]] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({
                id: directoryVendors.id,
                claimedByProfileId: directoryVendors.claimedByProfileId,
              })
              .from(directoryVendors)
              .where(
                and(
                  isNotNull(directoryVendors.handoffDueAt),
                  isNotNull(directoryVendors.claimedByProfileId),
                ),
              )
              .orderBy(asc(directoryVendors.handoffDueAt), asc(directoryVendors.id))
              .limit(limit)
              .all(),
          ),
          dbQuery(() =>
            db
              .select({ n: sql<number>`count(*)` })
              .from(directoryVendors)
              .where(isNotNull(directoryVendors.reviewOrgId))
              .all(),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.catchDefect((e) => Effect.fail(new ClaimReviewSweepError({ reason: String(e) }))),
      );

      const pending = counted?.n ?? 0;
      if (pending > 0) {
        yield* Effect.logWarning("vendor claims awaiting operator review", { pending });
      }

      let handedOff = 0;
      if (flush) {
        for (const row of due) {
          const vendorProfileId = row.claimedByProfileId!;
          // Take the listing: only the runner whose UPDATE changes the row
          // flushes it, so two overlapping runs never flush one listing twice.
          const taken = yield* dbQuery(() =>
            db
              .update(directoryVendors)
              .set({ handoffDueAt: null })
              .where(and(eq(directoryVendors.id, row.id), isNotNull(directoryVendors.handoffDueAt)))
              .run(),
          ).pipe(Effect.exit);
          if (Exit.isFailure(taken)) {
            yield* Effect.sync(() => metricVendorClaimReview("handoff_error"));
            yield* Effect.logError("vendor claim hand-off: take failed", {
              directoryVendorId: row.id,
            });
            continue;
          }
          if (rowsChanged(taken.value) === 0) continue;
          yield* flush({ directoryVendorId: row.id, vendorProfileId });
          handedOff += 1;
          yield* Effect.sync(() => metricVendorClaimReview("handed_off"));
        }
      } else if (due.length > 0) {
        yield* Effect.logWarning("vendor claim hand-off waiting: vendor chat is not configured", {
          due: due.length,
        });
      }

      yield* Effect.logInfo("vendor claim review sweep complete", { handedOff, pending });
      return { handedOff, pending };
    }).pipe(Effect.withSpan("cire.claimReview.sweep"));
  },
};
