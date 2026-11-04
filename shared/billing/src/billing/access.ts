/**
 * Deciding access, and applying it through the consumer's `onAccess` hook.
 *
 * Applying runs under the customer's access lease, and the lease holder checks
 * on release that no write landed while it decided (the access version). A
 * write that lands mid-decision bumps the version, so the holder reads again
 * and calls the hook again: the last call always carries the current decision.
 */

import { Duration, Effect } from "effect";

import { AccessBusy, AccessHookError } from "../errors";
import { metricAccessApplied, type AccessSource } from "../metrics";
import {
  decideFeature,
  isKnownStatus,
  nextBoundary,
  type FeatureAccess,
  type GrantFacts,
  type SubscriptionFacts,
} from "../policy";
import type { GrantRecord, SubscriptionRecord } from "../storage/port";
import { after, type BillingContext } from "./context";
import type { AccessDecision, ApplyError, BillingStatus, SubscriptionStatus } from "./types";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function subscriptionStatus(
  ctx: BillingContext,
  row: SubscriptionRecord,
): SubscriptionStatus {
  const paid =
    row.paidPeriodStart !== null && row.paidPeriodEnd !== null
      ? {
          id: `${row.providerSubscriptionId}:${seconds(row.paidPeriodStart)}`,
          start: row.paidPeriodStart,
          end: row.paidPeriodEnd,
        }
      : null;
  return {
    subscriptionId: row.providerSubscriptionId,
    planId: row.planId,
    group: ctx.planById.get(row.planId)?.group ?? null,
    status: row.status,
    interval: row.interval,
    currency: row.currency,
    currentPeriod:
      row.currentPeriodStart !== null && row.currentPeriodEnd !== null
        ? { start: row.currentPeriodStart, end: row.currentPeriodEnd }
        : null,
    trialEnd: row.trialEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    pastDueSince: row.pastDueSince,
    paidPeriod: paid,
    currentPeriodPaid:
      paid !== null &&
      row.currentPeriodStart !== null &&
      paid.start.getTime() === row.currentPeriodStart.getTime(),
  };
}

const facts = (ctx: BillingContext, rows: readonly SubscriptionRecord[]): SubscriptionFacts[] =>
  rows.map((row) => ({
    status: row.status,
    features: ctx.planById.get(row.planId)?.features.map((f) => f.id) ?? [],
    currentPeriodEnd: row.currentPeriodEnd,
    trialEnd: row.trialEnd,
    pastDueSince: row.pastDueSince,
  }));

const grantFacts = (grants: readonly GrantRecord[]): GrantFacts[] =>
  grants.map((g) => ({ featureId: g.featureId, expiresAt: g.expiresAt }));

/** The status for one customer from rows already read; logs a status it does not know. */
export const decideStatus = (
  ctx: BillingContext,
  customerRef: string,
  rows: readonly SubscriptionRecord[],
  grants: readonly GrantRecord[],
  now: Date,
): Effect.Effect<BillingStatus> =>
  Effect.gen(function* () {
    for (const row of rows) {
      if (!isKnownStatus(row.status)) {
        yield* Effect.logWarning("billing: unknown subscription status, no access given").pipe(
          Effect.annotateLogs({ status: row.status }),
        );
      }
    }
    const subscriptions = facts(ctx, rows);
    const features: Record<string, FeatureAccess> = {};
    for (const featureId of ctx.featureIds) {
      features[featureId] = decideFeature({
        featureId,
        subscriptions,
        grants: grantFacts(grants),
        policy: ctx.policy,
        now,
      });
    }
    return {
      customerRef,
      subscriptions: rows.map((row) => subscriptionStatus(ctx, row)),
      grants: grants.map((g) => ({
        featureId: g.featureId,
        source: g.source,
        grantedBy: g.grantedBy,
        expiresAt: g.expiresAt,
      })),
      features,
    };
  });

export const readState = (ctx: BillingContext, customerRef: string) =>
  Effect.all([ctx.storage.listSubscriptions(customerRef), ctx.storage.listGrants(customerRef)], {
    concurrency: 2,
  });

/** Runs the hook under its timeout; a timeout aborts the signal the hook was given. */
const runHook = (ctx: BillingContext, decision: AccessDecision) => {
  const hook = ctx.onAccess;
  if (!hook) return Effect.void;
  return Effect.suspend(() => {
    const controller = new AbortController();
    return hook(decision, { signal: controller.signal }).pipe(
      Effect.mapError(() => new AccessHookError({ reason: "failed" })),
      Effect.timeoutOrElse({
        duration: ctx.tuning.hookTimeoutMs,
        orElse: () =>
          Effect.sync(() => controller.abort()).pipe(
            Effect.andThen(Effect.fail(new AccessHookError({ reason: "timeout" }))),
          ),
      }),
    );
  });
};

export type ApplyOutcome = "applied" | "covered";

/**
 * How a call waits while another process holds the lease. `write`: the caller
 * has just made a write access depends on, so it stops as soon as a completed
 * application covers that write. `lease`: it waits for the lease itself
 * (`reapplyAll`). `never`: it gives up at once (the sweep, which comes back).
 */
export type ApplyWait = "write" | "lease" | "never";

/**
 * Apply the current decision for `customerRef`. A wait polls by reading the
 * row alone, backing off from `backoffMs` to `backoffMaxMs`, and takes the
 * lease again only once the row shows it free. When the hook fails the row is
 * left due at `retryAt` when given (the sweep), else at once.
 */
export const applyAccess = (
  ctx: BillingContext,
  customerRef: string,
  source: AccessSource,
  wait: ApplyWait,
  retryAt?: Date,
): Effect.Effect<ApplyOutcome, ApplyError> =>
  Effect.gen(function* () {
    const { storage, tuning } = ctx;
    const deadline = performance.now() + tuning.accessBudgetMs;
    let pause = tuning.backoffMs;
    const backOff = Effect.suspend(() => {
      const ms = pause;
      pause = Math.min(pause * 2, tuning.backoffMaxMs);
      return Effect.sleep(Duration.millis(ms));
    });
    let target: number | null = null;
    for (;;) {
      const now = ctx.now();
      const token = after(now, tuning.leaseMs);
      const lease = yield* storage.acquireAccess({ customerRef, now, until: token });
      if (lease === null) {
        if (wait === "never") return yield* Effect.fail(new AccessBusy());
        // A caller after a write reads at once, so the version its write must
        // see applied is fixed before anyone else's write can raise it.
        let readNow = wait === "write" && target === null;
        for (;;) {
          if (!readNow) {
            if (performance.now() >= deadline) return yield* Effect.fail(new AccessBusy());
            yield* backOff;
          }
          readNow = false;
          const row = yield* storage.findCustomer(customerRef);
          if (row === null) return yield* Effect.fail(new AccessBusy());
          if (wait === "write") {
            target ??= row.accessVersion;
            if (row.accessAppliedVersion >= target) return "covered" as const;
          }
          const lock = row.accessLockUntil;
          if (lock === null || lock.getTime() <= ctx.now().getTime()) break;
        }
        continue;
      }
      const [rows, grants] = yield* readState(ctx, customerRef);
      const status = yield* decideStatus(ctx, customerRef, rows, grants, now);
      const decision: AccessDecision = { ...status, version: lease.version, decidedAt: now };
      const due = {
        dueAt: now,
        retry: retryAt ? { until: retryAt, version: lease.version } : null,
      };
      yield* runHook(ctx, decision).pipe(
        Effect.tapError((error) =>
          error.reason === "timeout"
            ? // The hook may still be writing: keep the lease until it expires,
              // so no newer holder's write can land before this one.
              storage.markAccessDue({ customerRef, ...due })
            : storage.releaseAccess({ customerRef, token, ...due }),
        ),
      );
      const boundary = nextBoundary({
        subscriptions: facts(ctx, rows),
        grants: grantFacts(grants),
        policy: ctx.policy,
        now,
      });
      if (yield* storage.completeAccess({ customerRef, token, version: lease.version, boundary })) {
        return "applied" as const;
      }
      // A write landed while deciding: free the lease and decide again.
      yield* storage.releaseAccess({ customerRef, token, dueAt: now, retry: null });
      if (performance.now() >= deadline) return yield* Effect.fail(new AccessBusy());
      yield* backOff;
    }
  }).pipe(
    Effect.tap((outcome) =>
      Effect.sync(() => metricAccessApplied(source, outcome === "covered" ? "applied" : outcome)),
    ),
    Effect.tapError((error) =>
      Effect.sync(() =>
        metricAccessApplied(
          source,
          error._tag === "AccessBusy"
            ? "busy"
            : error._tag === "AccessHookError"
              ? "hook_failed"
              : "error",
        ),
      ).pipe(
        Effect.andThen(
          error._tag === "AccessBusy"
            ? Effect.logWarning("billing: access lease stayed busy; the row is left due")
            : error._tag === "AccessHookError"
              ? Effect.logError("billing: onAccess did not complete; the row is left due").pipe(
                  Effect.annotateLogs({ reason: error.reason }),
                )
              : Effect.void,
        ),
      ),
    ),
    Effect.annotateLogs({ source }),
    Effect.withSpan("billing.access.apply", { attributes: { "billing.access.source": source } }),
  );

/**
 * Erasure. Under the customer's lease, so no other application's hook runs
 * meanwhile: hands the hook a final decision that denies every feature, at a
 * version above every earlier one, then deletes the customer's rows while the
 * lease still holds. `null` when the package holds no row for the ref.
 */
export const forgetCustomer = (
  ctx: BillingContext,
  customerRef: string,
): Effect.Effect<{ readonly providerCustomerId: string | null } | null, ApplyError> =>
  Effect.gen(function* () {
    const { storage, tuning } = ctx;
    const deadline = performance.now() + tuning.accessBudgetMs;
    for (;;) {
      if ((yield* storage.findCustomer(customerRef)) === null) return null;
      const now = ctx.now();
      const token = after(now, tuning.leaseMs);
      const lease = yield* storage.acquireAccess({ customerRef, now, until: token });
      if (lease !== null) {
        const denied = yield* decideStatus(ctx, customerRef, [], [], now);
        yield* runHook(ctx, { ...denied, version: lease.version, decidedAt: now }).pipe(
          Effect.tapError((error) =>
            error.reason === "timeout"
              ? storage.markAccessDue({ customerRef, dueAt: now, retry: null })
              : storage.releaseAccess({ customerRef, token, dueAt: now, retry: null }),
          ),
        );
        const forgotten = yield* storage.forgetCustomer({ customerRef, token });
        if (forgotten !== null) return forgotten;
      }
      if (performance.now() >= deadline) return yield* Effect.fail(new AccessBusy());
      yield* Effect.sleep(Duration.millis(tuning.backoffMs));
    }
  }).pipe(Effect.withSpan("billing.forget_customer"));
