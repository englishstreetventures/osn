/**
 * The app-side half of vendor claim review. A redeemed claim waits on the
 * listing (`directory_vendors.review_*`) until an operator confirms or rejects
 * it with `scripts/cire-vendor-claim-review.ts`, which runs SQL against D1 and
 * so cannot run app code. Two things therefore happen here, on the daily cron:
 *
 *  - Hand-off. Couples' enquiries to an unclaimed listing wait as
 *    `pending_body` with no chat. Once a listing has a claimant
 *    (`claimed_by_profile_id`, written only by the operator's confirm), the
 *    sweep hands each such enquiry to the vendor (`flushBufferedEnquiry`). The
 *    work is read from that state, not from a flag, so an enquiry whose
 *    hand-off failed stays buffered and is retried the next day. Enquiries
 *    sent after the confirm go straight to the vendor. A failed hand-off
 *    moves its enquiry to the back of the queue.
 *  - Reminder. It counts the claims still waiting and logs a warning when any
 *    are, so an operator reading Workers Logs sees them daily.
 *
 * Each hand-off costs two zap-api calls and one D1 write, and the cron's one
 * invocation shares the Free plan's per-invocation ceilings (50 external
 * subrequests, 50 D1 queries) with the other jobs
 * (`wiki/shared/free-tier-limits.md`). `HANDOFFS_PER_RUN` bounds the enquiries
 * taken per run; the rest wait for the next day.
 */
import { directoryVendors, vendorEnquiries } from "@cire/db";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricVendorClaimReview } from "../metrics";
import { flushBufferedEnquiry } from "./enquiries";
import type { ZapChatClient } from "./zap-bridge";

export class ClaimReviewSweepError extends Data.TaggedError("ClaimReviewSweepError")<{
  reason: string;
}> {}

/** Buffered enquiries handed off per cron run: 20 zap calls, 10 D1 writes. */
export const HANDOFFS_PER_RUN = 10;

export interface ClaimReviewSweepResult {
  handedOff: number;
  pending: number;
}

export const claimReviewService = {
  /**
   * `zap` null (vendor chat not configured) skips the hand-off and leaves
   * every enquiry buffered for a run that has it.
   */
  sweep(
    zap: ZapChatClient | null,
    limit: number = HANDOFFS_PER_RUN,
  ): Effect.Effect<ClaimReviewSweepResult, ClaimReviewSweepError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [due, [counted]] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({
                id: vendorEnquiries.id,
                createdBy: vendorEnquiries.createdBy,
                pendingBody: vendorEnquiries.pendingBody,
                vendorProfileId: directoryVendors.claimedByProfileId,
              })
              .from(vendorEnquiries)
              .innerJoin(
                directoryVendors,
                eq(directoryVendors.id, vendorEnquiries.directoryVendorId),
              )
              .where(
                and(
                  // A literal, not a bound 'open': SQLite uses the partial
                  // `vendor_enquiries_buffered_idx` only when the query's
                  // WHERE visibly implies the index's own.
                  sql`${vendorEnquiries.status} = 'open'`,
                  isNull(vendorEnquiries.zapChatId),
                  isNotNull(vendorEnquiries.pendingBody),
                  isNotNull(directoryVendors.claimedByProfileId),
                ),
              )
              // Least recently tried first: a failed hand-off bumps
              // `updated_at`, so an enquiry that keeps failing moves to the
              // back instead of holding the run's slots.
              .orderBy(asc(vendorEnquiries.updatedAt), asc(vendorEnquiries.id))
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

      if (!zap) {
        if (due.length > 0) {
          yield* Effect.logWarning("vendor claim hand-off waiting: vendor chat is not configured", {
            due: due.length,
          });
        }
        return { handedOff: 0, pending };
      }

      const outcomes = yield* Effect.all(
        due.map((row) => flushBufferedEnquiry(zap, row, row.vendorProfileId!)),
        { concurrency: 5 },
      );
      const handedOff = outcomes.filter(Boolean).length;
      const failed = outcomes.length - handedOff;
      yield* Effect.sync(() => {
        if (handedOff > 0) metricVendorClaimReview("handed_off", handedOff);
        if (failed > 0) metricVendorClaimReview("handoff_error", failed);
      });

      yield* Effect.logInfo("vendor claim review sweep complete", { handedOff, failed, pending });
      return { handedOff, pending };
    }).pipe(Effect.withSpan("cire.claimReview.sweep"));
  },
};
