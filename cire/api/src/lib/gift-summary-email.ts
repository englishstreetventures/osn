/**
 * Delivery of the retention sweep's parting gift summary.
 *
 * The sweep deletes a wedding's guest data a year after its last event, and
 * leaves the couple a record on `registry_settings`: counts, totals and each
 * money gift's amount and day, with no names. This is the half that
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

import { EmailService, type SendEmailInput } from "@shared/email";
import type { RegistryGiftSummaryData } from "@shared/email/templates";
import { Effect } from "effect";

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

/**
 * The `registry-gift-summary` template's data for one notice, every amount
 * printed with its own currency's minor unit (`formatMinor`).
 *
 * Nothing is converted: every gift is charged in the wedding's currency, so a
 * gift in another one was given before the couple changed it, and it stays in
 * its own. Each currency gets its own total with the gifts it adds — the
 * couple's first — and each listed gift names its currency when it is not the
 * couple's, so the email can say it sits outside their total.
 */
function summaryEmailData(notice: GiftSummaryNotice): RegistryGiftSummaryData {
  const couple = notice.currency.toUpperCase();
  const { count, totals, gifts } = notice.summary.contributions;
  const ours = (currency: string) => currency.toUpperCase() === couple;
  return {
    weddingName: notice.weddingName,
    finalEventOn: notice.finalEventOn,
    sweptOn: notice.summary.sweptOn,
    giftCount: count,
    giftCurrency: couple,
    giftTotals: [
      ...totals.filter((t) => ours(t.currency)),
      ...totals.filter((t) => !ours(t.currency)),
    ].map((t) => ({
      currency: t.currency,
      total: formatMinor(t.amountMinor, t.currency),
      count: t.count ?? null,
    })),
    gifts: gifts.map((g) => ({
      on: g.on,
      amount: formatMinor(g.amountMinor, g.currency),
      otherCurrency: ours(g.currency) ? null : g.currency,
    })),
    giftsUnlisted: Math.max(0, count - gifts.length),
    listPurchased: notice.summary.claims.purchased,
    listReserved: notice.summary.claims.reserved,
  };
}

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
    // The data is built once per wedding and shared by its recipients: every
    // listed gift is formatted here, and the cron's CPU is shared by every job.
    const sends = plans.flatMap(({ notice, recipients }) => {
      if (recipients.size === 0) return [];
      const data = summaryEmailData(notice);
      return [...recipients].map((to) => ({
        weddingId: notice.weddingId,
        input: { template: "registry-gift-summary", to, data } satisfies SendEmailInput,
      }));
    });
    yield* Effect.annotateCurrentSpan({ recipients: sends.length, unmailed });
    if (sends.length === 0) return;

    // One provider call for the cohort where the transport takes batches.
    // Each send is an external subrequest, and the cron's one invocation —
    // every sweep, the RSVP digest included — shares a budget of 50; a cohort
    // of 25 weddings with two owners each would spend all of it one by one.
    // A failed batch is logged once: the transport has already counted each
    // email's outcome by template, and there is no later chance to send.
    if (emailSvc.sendBatch) {
      yield* emailSvc
        .sendBatch(sends.map((s) => s.input))
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("[gift-summary-email] batch send failed — continuing").pipe(
              Effect.annotateLogs({ template: "registry-gift-summary", recipients: sends.length }),
            ),
          ),
        );
      return;
    }

    // Without batches, one send each, four at a time: the sends are
    // independent, and a cohort is however many weddings passed their year on
    // the same day — which should not become that many simultaneous sends.
    yield* Effect.forEach(
      sends,
      ({ weddingId, input }) =>
        emailSvc.send(input).pipe(
          // Caught per send, so one bounced address costs neither the
          // wedding's other owners nor the rest of the cohort their summary.
          Effect.catchCause(() =>
            Effect.logWarning("[gift-summary-email] send failed — continuing").pipe(
              Effect.annotateLogs({ template: "registry-gift-summary", weddingId }),
            ),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    // The lookup and every send are already caught, so only a defect — a
    // transport that throws instead of failing — can reach here.
    Effect.catchCause(() =>
      Effect.logWarning("[gift-summary-email] summary delivery failed — sweep unaffected").pipe(
        Effect.annotateLogs({ reason: "defect" }),
      ),
    ),
    Effect.withSpan("cire.retention.sendGiftSummaryEmails"),
  );
}
