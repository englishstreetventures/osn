/**
 * Delivery of the retention sweep's parting gift summary.
 *
 * The sweep deletes a wedding's guest data a year after its last event, and
 * leaves the couple an aggregate on `registry_settings`. This is the half that
 * actually reaches them: it asks osn-api for every owner's address (cire stores
 * none of its own) and sends the wedding's summary to each of them — one email
 * per distinct address, so two owners who share an inbox get it once.
 *
 * Everything here is fail-soft, on purpose. By the time this runs the deletes
 * have committed — the obligation is discharged and the email is a courtesy.
 * A dead mailbox, a 500 from osn-api, a Resend outage: each costs one owner
 * one email and nothing else. There is no retry anywhere in this file, because
 * the caller is a cron sweep and a retry loop against a mailbox that is still
 * down would only mail the same couple again on the next run with no new data.
 *
 * Fail-soft is not silent. No later sweep resends a summary — the next run
 * finds no gift rows left — so an osn-api that does not answer is logged and
 * counted here, and a wedding that reached nobody is counted by why.
 */

import { EmailService } from "@shared/email";
import { Cause, Effect } from "effect";

import { metricGiftSummaryUnmailed } from "../metrics";
import type { OrganiserEmailAnswer, OsnOrganiserEmailLookup } from "../services/osn-bridge";
import type { GiftSummaryNotice } from "../services/retention";
import { formatMinor } from "./money";

/**
 * Log and count an osn-api that did not answer for every owner. Counts only:
 * which owners went unanswered is a profile id, and an address is what the
 * lookup was for.
 */
const reportUnanswered = (unmailed: number, weddings: number): Effect.Effect<void> =>
  Effect.logWarning("[gift-summary-email] osn-api did not answer for every owner").pipe(
    Effect.annotateLogs({ unmailed, weddings }),
    Effect.andThen(
      Effect.sync(() => {
        if (unmailed > 0) metricGiftSummaryUnmailed("lookup_failed", unmailed);
      }),
    ),
  );

export function sendGiftSummaryEmails(
  notices: readonly GiftSummaryNotice[],
  lookup: OsnOrganiserEmailLookup,
): Effect.Effect<void, never, EmailService> {
  return Effect.gen(function* () {
    if (notices.length === 0) return;
    const emailSvc = yield* EmailService;

    // One lookup for the whole cohort, not one per wedding: the addresses are
    // all wanted at the same moment and osn-api takes a batch. The lookup never
    // rejects by contract; if it does, that reads as osn-api not answering. A
    // hung osn-api is cut by the sweep's timeout, and that interrupt is the
    // likeliest shape of an outage, so it is reported here before it unwinds.
    const answer: OrganiserEmailAnswer = yield* Effect.tryPromise(() =>
      lookup([...new Set(notices.flatMap((n) => n.ownerOsnProfileIds))]),
    ).pipe(
      Effect.orElseSucceed(() => ({ answered: false, emails: new Map<string, string>() })),
      Effect.onInterrupt(() => reportUnanswered(notices.length, notices.length)),
    );

    // One send per (wedding, address). Whatever addresses came back are used
    // even when another call failed: there is no later chance to send.
    const plans = notices.map((notice) => ({
      notice,
      recipients: new Set(
        notice.ownerOsnProfileIds.flatMap((id) => {
          const to = answer.emails.get(id);
          return to ? [to] : [];
        }),
      ),
    }));
    const unmailed = plans.filter((p) => p.recipients.size === 0).length;
    if (!answer.answered) {
      yield* reportUnanswered(unmailed, notices.length);
    } else if (unmailed > 0) {
      // osn-api answered and had no address for any owner of these weddings.
      // It does not say why, so there is nothing to log — only to count.
      yield* Effect.sync(() => metricGiftSummaryUnmailed("no_address", unmailed));
    }
    const sends = plans.flatMap(({ notice, recipients }) =>
      [...recipients].map((to) => ({ notice, to })),
    );
    yield* Effect.annotateCurrentSpan({ recipients: sends.length, unmailed });

    // `Effect.forEach` with bounded concurrency rather than a for/await loop:
    // the sends are independent, `no-await-in-loop` is on for exactly this
    // case, and a cohort is however many weddings passed their year on the
    // same day — which should not become that many simultaneous sends.
    yield* Effect.forEach(
      sends,
      ({ notice, to }) => {
        const totals = notice.summary.contributions.totals;
        const primary = totals.find((t) => t.currency === notice.currency) ?? totals[0] ?? null;

        return emailSvc
          .send({
            template: "registry-gift-summary",
            to,
            data: {
              weddingName: notice.weddingName,
              finalEventOn: notice.finalEventOn,
              sweptOn: notice.summary.sweptOn,
              giftCount: notice.summary.contributions.count,
              giftTotal: primary ? formatMinor(primary.amountMinor, primary.currency) : null,
              listPurchased: notice.summary.claims.purchased,
              listReserved: notice.summary.claims.reserved,
            },
          })
          .pipe(
            // Caught per send, so one bounced address costs neither the
            // wedding's other owners nor the rest of the cohort their summary.
            Effect.catchCause(() =>
              Effect.logWarning("[gift-summary-email] send failed — continuing").pipe(
                Effect.annotateLogs({
                  template: "registry-gift-summary",
                  weddingId: notice.weddingId,
                }),
              ),
            ),
          );
      },
      { concurrency: 4, discard: true },
    );
  }).pipe(
    // The lookup and every send are already caught, so only an interrupt (the
    // sweep's timeout) or a defect can reach here.
    Effect.catchCause((cause) =>
      Effect.logWarning("[gift-summary-email] summary delivery failed — sweep unaffected").pipe(
        Effect.annotateLogs({ reason: Cause.hasInterruptsOnly(cause) ? "interrupted" : "defect" }),
      ),
    ),
    Effect.withSpan("cire.retention.sendGiftSummaryEmails"),
  );
}
