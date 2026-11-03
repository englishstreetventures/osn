import type { PaidPeriod } from "../provider/port";
import type { StripeInvoice } from "./schemas";

/**
 * Invoices that can pay for a period of service: the first, each renewal, and
 * an update that restarts the period (an early trial end, a resume, a new
 * billing anchor). An update's prorations are excluded line by line below, so
 * an upgrade mid-period never names a second paid period inside one month.
 */
const PERIOD_REASONS: ReadonlySet<string> = new Set([
  "subscription_create",
  "subscription_cycle",
  "subscription_update",
]);

const seconds = (s: number) => new Date(s * 1000);

/**
 * The billing period this invoice confirms paid for `subscriptionId`, or `null`.
 *
 * Paid means: the invoice is `paid`, its total after discounts is above zero,
 * it is a period invoice, and it holds a non-proration line for this
 * subscription with an amount above zero. A trial's invoice has that line at 0,
 * even when a one-off item beside it is not; a 100%-off coupon makes the total
 * 0. Neither confirms a period. Several qualifying lines: the latest period.
 */
export function paidPeriodOf(invoice: StripeInvoice, subscriptionId: string): PaidPeriod | null {
  if (invoice.status !== "paid" || (invoice.total ?? 0) <= 0) return null;
  if (!PERIOD_REASONS.has(invoice.billing_reason ?? "")) return null;
  let best: { start: number; end: number } | null = null;
  for (const line of invoice.lines.data) {
    const parent = line.parent;
    const details = parent?.subscription_item_details;
    if (parent?.type !== "subscription_item_details" || !details) continue;
    if (details.subscription !== subscriptionId || details.proration === true) continue;
    if (line.amount <= 0 || line.period.end <= line.period.start) continue;
    if (best === null || line.period.end > best.end) best = line.period;
  }
  return best === null ? null : { start: seconds(best.start), end: seconds(best.end) };
}

/** The subscription an invoice belongs to (basil: under `parent`). */
export const invoiceSubscriptionId = (invoice: StripeInvoice): string | null =>
  invoice.parent?.type === "subscription_details"
    ? (invoice.parent.subscription_details?.subscription ?? null)
    : null;
