/**
 * Delivery of the retention sweep's parting gift summary.
 *
 * The sweep deletes a wedding's guest data a year after its last event, and
 * leaves the couple an aggregate on `registry_settings`. This is the half that
 * actually reaches them: it asks osn-api for the organiser's address (cire
 * stores none of its own) and sends one email per wedding.
 *
 * Everything here is fail-soft, on purpose. By the time this runs the deletes
 * have committed — the obligation is discharged and the email is a courtesy.
 * A dead mailbox, a 500 from osn-api, a Resend outage: each costs one couple
 * one email and nothing else. There is no retry anywhere in this file, because
 * the caller is a cron sweep and a retry loop against a mailbox that is still
 * down would only mail the same couple again on the next run with no new data.
 */

import { EmailService } from "@shared/email";
import { Effect } from "effect";

import type { GiftSummaryNotice } from "../services/retention";

/** Resolves OSN profile ids to account addresses. Missing entry = no mail. */
export type OrganiserEmailLookup = (
  profileIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/**
 * One formatter per currency, kept for the life of the module.
 * Constructing an `Intl.NumberFormat` is the expensive part, and a cohort is
 * usually one currency repeated, so building it per wedding is waste. Only
 * successful constructions are cached: a malformed code must keep throwing on
 * every call rather than caching a broken formatter.
 */
const formatters = new Map<string, Intl.NumberFormat>();

/**
 * Formats a minor-unit total in the wedding's own currency. `Intl` throws on a
 * malformed currency code, and a bad code in one row must not cost the whole
 * cohort its summaries, so the fallback prints the number and the code as-is.
 */
function formatTotal(currency: string, amountMinor: number): string {
  try {
    let formatter = formatters.get(currency);
    if (!formatter) {
      formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
      formatters.set(currency, formatter);
    }
    return formatter.format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

export function sendGiftSummaryEmails(
  notices: readonly GiftSummaryNotice[],
  lookup: OrganiserEmailLookup,
): Effect.Effect<void, never, EmailService> {
  return Effect.gen(function* () {
    if (notices.length === 0) return;
    const emailSvc = yield* EmailService;

    // One lookup for the whole cohort, not one per wedding: the addresses are
    // all wanted at the same moment and osn-api takes a batch.
    const addresses = yield* Effect.tryPromise({
      try: () => lookup(notices.map((n) => n.ownerOsnProfileId)),
      catch: (cause) => new Error("organiser email lookup failed", { cause }),
    });

    // `Effect.forEach` with bounded concurrency rather than a for/await loop:
    // the sends are independent, `no-await-in-loop` is on for exactly this
    // case, and a cohort is however many weddings passed their year on the
    // same day — which should not become that many simultaneous sends.
    yield* Effect.forEach(
      notices,
      (notice) => {
        const to = addresses.get(notice.ownerOsnProfileId);
        // No address, no mail, no error. osn-api omits ids it cannot answer
        // for and does not say why; there is nothing to report here.
        if (!to) return Effect.void;

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
              giftTotal: primary ? formatTotal(primary.currency, primary.amountMinor) : null,
              listPurchased: notice.summary.claims.purchased,
              listReserved: notice.summary.claims.reserved,
            },
          })
          .pipe(
            // Caught per wedding, so one bounced address does not cost the
            // rest of the cohort their summaries.
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
    Effect.catchCause(() =>
      Effect.logWarning("[gift-summary-email] summary delivery failed — sweep unaffected").pipe(
        Effect.annotateLogs({ reason: "lookup_or_transport_error" }),
      ),
    ),
    Effect.withSpan("cire.retention.sendGiftSummaryEmails"),
  );
}
