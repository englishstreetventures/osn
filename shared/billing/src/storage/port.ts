/**
 * What the billing core asks of its database. Methods return Effects, so an
 * adapter for another database (Postgres) can be added beside the SQLite one.
 *
 * Contract every adapter keeps, and `tests/storage/contract.ts` checks:
 *  - Every write access depends on (a subscription, a paid period, a grant)
 *    commits together with the customer's dirty mark, data first: the access
 *    version goes up and the access boundary comes due now.
 *    On D1 the two commit atomically (one batch); on bun:sqlite they run in
 *    that order, one after the other.
 *  - Compare-and-set methods never overwrite a newer value. Those whose caller
 *    acts on the outcome answer whether they won; the rest (`abandonCheckout`,
 *    `clearCheckout`, `markTrialUsed`, `releaseEvent`, `finishEvent`) return
 *    nothing.
 */

import type { Effect } from "effect";

import type { BillingStorageError } from "../errors";

type E = BillingStorageError;

export interface PendingCheckout {
  readonly sessionId: string | null;
  readonly planId: string;
  readonly currency: string;
  readonly nonce: string;
  readonly startedAt: Date;
}

export interface CustomerRecord {
  readonly id: string;
  readonly customerRef: string;
  readonly providerCustomerId: string | null;
  readonly trialUsedAt: Date | null;
  readonly pendingCheckout: PendingCheckout | null;
  readonly nextAccessBoundaryAt: Date | null;
  readonly accessLockUntil: Date | null;
  readonly accessVersion: number;
  /** The access version the last completed application was decided at. */
  readonly accessAppliedVersion: number;
}

export interface SubscriptionRecord {
  readonly providerSubscriptionId: string;
  readonly customerRef: string;
  /** `null` when its price maps to no plan; such a subscription grants nothing. */
  readonly planId: string | null;
  readonly providerPriceId: string;
  readonly interval: string | null;
  readonly status: string;
  readonly currency: string;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly trialEnd: Date | null;
  readonly pastDueSince: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly paidPeriodStart: Date | null;
  readonly paidPeriodEnd: Date | null;
  readonly fetchStartedAt: Date;
  readonly reconciledAt: Date | null;
}

/** A fresh read from the provider. `pastDueSince` is the storage's to keep. */
export type SubscriptionWrite = Omit<
  SubscriptionRecord,
  "pastDueSince" | "paidPeriodStart" | "paidPeriodEnd" | "reconciledAt"
>;

export interface GrantRecord {
  readonly customerRef: string;
  readonly featureId: string;
  readonly source: "comp";
  readonly grantedBy: string;
  readonly expiresAt: Date | null;
}

/** A later due time for a row whose application failed, valid only at `version`. */
export interface AccessRetry {
  readonly until: Date;
  readonly version: number;
}

export type EventClaim = "claimed" | "done" | "held";
export type EventOutcome = "processed" | "ignored";

export interface ReconcileSelection {
  readonly now: Date;
  readonly limit: number;
  /** Rows attempted at or after this are skipped. */
  readonly attemptedBefore: Date;
  /** An active period that started inside [from, to) and is not yet confirmed paid is due too. */
  readonly unconfirmedFrom: Date;
  readonly unconfirmedTo: Date;
}

export interface BillingStorage {
  /** The customer's row, created when absent. Concurrent calls agree on one row. */
  ensureCustomer(customerRef: string, now: Date): Effect.Effect<CustomerRecord, E>;
  findCustomer(customerRef: string): Effect.Effect<CustomerRecord | null, E>;
  findCustomerByProviderId(providerCustomerId: string): Effect.Effect<CustomerRecord | null, E>;
  /** Sets the provider customer id only while it is unset. */
  setProviderCustomerId(customerId: string, providerCustomerId: string): Effect.Effect<boolean, E>;
  /** Starts a pending checkout, only while the stored nonce is still `expectedNonce`. */
  claimCheckout(input: {
    readonly customerId: string;
    readonly expectedNonce: string | null;
    readonly nonce: string;
    readonly planId: string;
    readonly currency: string;
    readonly now: Date;
  }): Effect.Effect<boolean, E>;
  /** Records the session a pending checkout created, only while its nonce still holds. */
  setCheckoutSession(input: {
    readonly customerId: string;
    readonly nonce: string;
    readonly sessionId: string;
  }): Effect.Effect<boolean, E>;
  /**
   * Drops a pending checkout that never got a session, only while it is still
   * this nonce; `restore` puts back the one it replaced.
   */
  abandonCheckout(input: {
    readonly customerId: string;
    readonly nonce: string;
    readonly restore?: PendingCheckout;
  }): Effect.Effect<void, E>;
  /** Clears the pending checkout when it is this session (matched by session id only). */
  clearCheckout(input: {
    readonly customerId: string;
    readonly sessionId: string;
  }): Effect.Effect<void, E>;
  markTrialUsed(customerId: string, at: Date): Effect.Effect<void, E>;

  findSubscription(providerSubscriptionId: string): Effect.Effect<SubscriptionRecord | null, E>;
  listSubscriptions(customerRef: string): Effect.Effect<readonly SubscriptionRecord[], E>;
  /** Writes unless a stored fetch started later; then marks the customer dirty. */
  upsertSubscription(write: SubscriptionWrite, now: Date): Effect.Effect<void, E>;
  /** Moves the paid period forward only; then marks the customer dirty. */
  recordPaidPeriod(input: {
    readonly providerSubscriptionId: string;
    readonly customerRef: string;
    readonly start: Date;
    readonly end: Date;
    readonly now: Date;
  }): Effect.Effect<void, E>;
  markReconciled(providerSubscriptionId: string, at: Date): Effect.Effect<void, E>;
  listSubscriptionsToReconcile(
    selection: ReconcileSelection,
  ): Effect.Effect<readonly SubscriptionRecord[], E>;

  listGrants(customerRef: string): Effect.Effect<readonly GrantRecord[], E>;
  /** Writes or replaces the grant; then marks the customer dirty. */
  upsertGrant(grant: GrantRecord, now: Date): Effect.Effect<void, E>;
  /** Removes the grant; then marks the customer dirty. Answers whether one existed. */
  deleteGrant(customerRef: string, featureId: string, now: Date): Effect.Effect<boolean, E>;

  /**
   * Claims an event: `done` when already processed, `held` while another
   * claim's lease runs. A won claim's `leaseUntil` is its token.
   */
  claimEvent(input: {
    readonly eventId: string;
    readonly type: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Effect.Effect<EventClaim, E>;
  /** Records the outcome, only while the claim is still the one `token` names. */
  finishEvent(eventId: string, outcome: EventOutcome, token: Date): Effect.Effect<void, E>;
  /**
   * Drops an unfinished claim so the next delivery can take it at once, only
   * while it is still the one `token` names.
   */
  releaseEvent(eventId: string, token: Date): Effect.Effect<void, E>;
  /** Deletes up to `limit` events received before `before`, oldest first, finished or not. */
  pruneEvents(before: Date, limit: number): Effect.Effect<number, E>;

  /**
   * Takes the customer's access lease when free or expired, raising the access
   * version and returning the raised value from the same statement; `null`
   * while another holds it. The lease's expiry is its token. A version only
   * rises and never falls below the clock (1,000 per millisecond).
   */
  acquireAccess(input: {
    readonly customerRef: string;
    readonly now: Date;
    readonly until: Date;
  }): Effect.Effect<{ readonly version: number } | null, E>;
  /**
   * Frees the lease, writes the next boundary and records `version` as applied,
   * only if no write landed since `version` was read.
   */
  completeAccess(input: {
    readonly customerRef: string;
    readonly token: Date;
    readonly version: number;
    readonly boundary: Date | null;
  }): Effect.Effect<boolean, E>;
  /**
   * Frees the lease if still held by `token`, leaving the row due at `dueAt` or
   * earlier. With `retry`, due at `retry.until` instead, so a row the sweep
   * could not apply goes behind the rows it has not tried yet; but only while
   * the access version is still `retry.version`: after a newer write the row
   * stays due at `dueAt`, so that write is applied without waiting.
   */
  releaseAccess(input: {
    readonly customerRef: string;
    readonly token: Date;
    readonly dueAt: Date;
    readonly retry: AccessRetry | null;
  }): Effect.Effect<void, E>;
  /** Leaves the lease to expire on its own; only marks the row due, as `releaseAccess` does. */
  markAccessDue(input: {
    readonly customerRef: string;
    readonly dueAt: Date;
    readonly retry: AccessRetry | null;
  }): Effect.Effect<void, E>;
  /** Customer refs whose boundary is due and whose lease is free, earliest first. */
  listDueCustomers(now: Date, limit: number): Effect.Effect<readonly string[], E>;

  /**
   * Deletes the customer's grants, subscriptions and row together, children
   * first, only while `token` still holds its access lease. Answers the
   * provider customer id the row held; `null` when the lease does not hold
   * (nothing is deleted).
   */
  forgetCustomer(input: {
    readonly customerRef: string;
    readonly token: Date;
  }): Effect.Effect<{ readonly providerCustomerId: string | null } | null, E>;
}
