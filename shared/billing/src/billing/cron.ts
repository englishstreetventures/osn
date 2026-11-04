/**
 * The scheduled half. Run `reconcile` first, then `sweepAccess`, so a lost
 * renewal webhook is repaired before anyone is lapsed for it.
 *
 * Costs per item, for sizing `limit` against a Worker's per-invocation budget
 * (Free plan: 50 D1 queries, 50 external subrequests):
 *  - reconcile: 1–2 Stripe calls (the subscription; its latest invoice when the
 *    period is unconfirmed) and about 10 queries, plus the hook's own; a busy
 *    lease adds about 6 reads.
 *  - sweepAccess: about 4 queries, plus the hook's own; it never waits on a lease.
 *  - pruneWebhookEvents: 1 query, writing up to 3 rows per claim deleted.
 */

import { Effect } from "effect";

import { metricReconcile } from "../metrics";
import type { SubscriptionRecord } from "../storage/port";
import { applyAccess } from "./access";
import { after, type BillingContext } from "./context";
import type { ReapplyReport, ReconcileReport, SweepReport } from "./types";
import { planIdFor } from "./webhook";

const refresh = (ctx: BillingContext, row: SubscriptionRecord) =>
  Effect.gen(function* () {
    const fetchStartedAt = ctx.now();
    const sub = yield* ctx.provider.retrieveSubscription(row.providerSubscriptionId);
    const now = ctx.now();
    if (sub === null) {
      // Gone at the provider (a reset test account): it is over, and is not
      // fetched again.
      yield* Effect.logWarning("billing: subscription missing at the provider; marked canceled");
      yield* ctx.storage.upsertSubscription({ ...row, status: "canceled", fetchStartedAt }, now);
      yield* applyAccess(ctx, row.customerRef, "reconcile", "write");
      return "missing" as const;
    }
    yield* ctx.storage.upsertSubscription(
      {
        providerSubscriptionId: sub.id,
        customerRef: row.customerRef,
        planId: planIdFor(ctx, sub) ?? row.planId,
        providerPriceId: sub.priceId,
        interval: sub.interval,
        status: sub.status,
        currency: sub.currency,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        trialEnd: sub.trialEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        fetchStartedAt,
      },
      now,
    );
    const unconfirmed =
      sub.status === "active" &&
      sub.currentPeriodStart !== null &&
      (row.paidPeriodStart === null ||
        row.paidPeriodStart.getTime() < sub.currentPeriodStart.getTime());
    if (unconfirmed && sub.latestInvoiceId !== null) {
      const period = yield* ctx.provider.retrieveInvoicePaidPeriod(sub.latestInvoiceId, sub.id);
      if (period !== null) {
        yield* ctx.storage.recordPaidPeriod({
          providerSubscriptionId: sub.id,
          customerRef: row.customerRef,
          start: period.start,
          end: period.end,
          now,
        });
      }
    }
    yield* applyAccess(ctx, row.customerRef, "reconcile", "write");
    return "refreshed" as const;
  });

export const reconcile = (ctx: BillingContext, limit: number) =>
  Effect.gen(function* () {
    const now = ctx.now();
    const rows = yield* ctx.storage.listSubscriptionsToReconcile({
      now,
      limit,
      attemptedBefore: after(now, -ctx.tuning.reconcileRetryMs),
      unconfirmedFrom: after(now, -ctx.tuning.unconfirmedMaxAgeMs),
      unconfirmedTo: after(now, -ctx.tuning.unconfirmedMinAgeMs),
    });
    const report = { selected: rows.length, refreshed: 0, missing: 0, failed: 0 };
    for (const row of rows) {
      // Recorded before the call, so an invocation killed mid-way does not
      // leave the same rows at the head of the next run.
      yield* ctx.storage.markReconciled(row.providerSubscriptionId, now);
      const outcome = yield* Effect.exit(refresh(ctx, row));
      if (outcome._tag === "Success") {
        report[outcome.value] += 1;
        metricReconcile(outcome.value);
      } else {
        report.failed += 1;
        metricReconcile("error");
        yield* Effect.logError(
          "billing: reconcile could not refresh a subscription",
          outcome.cause,
        );
      }
    }
    return report satisfies ReconcileReport;
  }).pipe(Effect.withSpan("billing.reconcile"));

export const sweepAccess = (ctx: BillingContext, limit: number) =>
  Effect.gen(function* () {
    const now = ctx.now();
    const refs = yield* ctx.storage.listDueCustomers(now, limit);
    const report = { visited: refs.length, applied: 0, busy: 0, failed: 0 };
    // A row whose hook fails goes behind the rows not yet tried, so a few
    // failing customers cannot fill every run.
    const retryAt = after(now, ctx.tuning.sweepRetryMs);
    for (const ref of refs) {
      const outcome = yield* Effect.result(applyAccess(ctx, ref, "sweep", "never", retryAt));
      if (outcome._tag === "Success") report.applied += 1;
      else if (outcome.failure._tag === "AccessBusy") report.busy += 1;
      else report.failed += 1;
    }
    return report satisfies SweepReport;
  }).pipe(Effect.withSpan("billing.sweep"));

export const reapplyAll = (ctx: BillingContext, customerRefs: readonly string[]) =>
  Effect.gen(function* () {
    let applied = 0;
    const failed: string[] = [];
    for (const ref of customerRefs) {
      const outcome = yield* Effect.exit(
        ctx.storage
          .ensureCustomer(ref, ctx.now())
          .pipe(Effect.andThen(applyAccess(ctx, ref, "reapply", "lease"))),
      );
      if (outcome._tag === "Success") applied += 1;
      else failed.push(ref);
    }
    return { applied, failed } satisfies ReapplyReport;
  }).pipe(Effect.withSpan("billing.reapply"));
