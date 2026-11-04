/**
 * {@link BillingStorage} over Drizzle on SQLite: bun:sqlite locally, D1 when
 * deployed. `db` is the schema-less handle `@shared/db-utils` names `Db`, which
 * both drivers' handles satisfy.
 *
 * Each write access depends on goes out as one `commitBatch` with the dirty
 * mark after it: atomic on D1 (a batch is a transaction), in that order on
 * bun:sqlite. Compare-and-set answers come from `rowsChanged`, which reads both
 * drivers' result shapes, or from `RETURNING`.
 */

import { commitBatch, rowsChanged, type Db } from "@shared/db-utils";
import { and, asc, eq, gte, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { Effect } from "effect";

import { BillingStorageError } from "../errors";
import type {
  BillingStorage,
  CustomerRecord,
  EventClaim,
  GrantRecord,
  SubscriptionRecord,
} from "./port";
import type { BillingSqliteSchema } from "./sqlite-schema";

export interface SqliteBillingStorageConfig {
  readonly db: Db;
  readonly schema: BillingSqliteSchema;
}

const newCustomerId = () => `bcus_${crypto.randomUUID().replaceAll("-", "")}`;

export function createSqliteBillingStorage(config: SqliteBillingStorageConfig): BillingStorage {
  const { db } = config;
  const {
    billingCustomers: c,
    billingSubscriptions: s,
    billingWebhookEvents: ev,
    billingGrants: g,
  } = config.schema;

  /** One storage call: typed failure, a span, and no bound value in the message. */
  const q = <A>(
    operation: string,
    run: () => A | Promise<A>,
  ): Effect.Effect<A, BillingStorageError> =>
    Effect.tryPromise({
      try: () => Promise.resolve(run()),
      catch: (cause) => new BillingStorageError({ operation, message: String(cause) }),
    }).pipe(Effect.withSpan(`billing.storage.${operation}`));

  /** `col` pulled in to `at` unless already earlier; `min()` would be NULL on a NULL column. */
  const dueBy = (at: Date): SQL =>
    sql`CASE WHEN ${c.nextAccessBoundaryAt} IS NULL OR ${c.nextAccessBoundaryAt} > ${at.getTime()} THEN ${at.getTime()} ELSE ${c.nextAccessBoundaryAt} END`;

  /** The dirty mark: a write access depends on has landed for this customer. */
  const markDirty = (customerRef: string, now: Date) =>
    db
      .update(c)
      .set({ accessVersion: sql`${c.accessVersion} + 1`, nextAccessBoundaryAt: dueBy(now) })
      .where(eq(c.customerRef, customerRef));

  const toCustomer = (row: typeof c.$inferSelect): CustomerRecord => ({
    id: row.id,
    customerRef: row.customerRef,
    providerCustomerId: row.providerCustomerId,
    trialUsedAt: row.trialUsedAt,
    pendingCheckout:
      row.pendingCheckoutNonce !== null &&
      row.pendingCheckoutPlanId !== null &&
      row.pendingCheckoutCurrency !== null &&
      row.pendingCheckoutStartedAt !== null
        ? {
            sessionId: row.pendingCheckoutSessionId,
            planId: row.pendingCheckoutPlanId,
            currency: row.pendingCheckoutCurrency,
            nonce: row.pendingCheckoutNonce,
            startedAt: row.pendingCheckoutStartedAt,
          }
        : null,
    nextAccessBoundaryAt: row.nextAccessBoundaryAt,
    accessLockUntil: row.accessLockUntil,
    accessVersion: row.accessVersion,
    accessAppliedVersion: row.accessAppliedVersion,
  });

  const toSubscription = (row: typeof s.$inferSelect): SubscriptionRecord => ({ ...row });

  const findCustomerWhere = (operation: string, where: SQL | undefined) =>
    q(operation, () => db.select().from(c).where(where).limit(1).all()).pipe(
      Effect.map((rows) => (rows[0] ? toCustomer(rows[0]) : null)),
    );

  const noPending = {
    pendingCheckoutSessionId: null,
    pendingCheckoutPlanId: null,
    pendingCheckoutCurrency: null,
    pendingCheckoutNonce: null,
    pendingCheckoutStartedAt: null,
  } as const;

  return {
    ensureCustomer: (customerRef, now) =>
      q("ensure_customer", () =>
        db
          .insert(c)
          .values({ id: newCustomerId(), customerRef, createdAt: now })
          .onConflictDoNothing({ target: c.customerRef })
          .run(),
      ).pipe(
        Effect.andThen(findCustomerWhere("find_customer", eq(c.customerRef, customerRef))),
        Effect.flatMap((row) =>
          row
            ? Effect.succeed(row)
            : Effect.fail(
                new BillingStorageError({
                  operation: "ensure_customer",
                  message: "row missing after insert",
                }),
              ),
        ),
      ),

    findCustomer: (customerRef) =>
      findCustomerWhere("find_customer", eq(c.customerRef, customerRef)),

    findCustomerByProviderId: (providerCustomerId) =>
      findCustomerWhere(
        "find_customer_by_provider_id",
        eq(c.providerCustomerId, providerCustomerId),
      ),

    setProviderCustomerId: (customerId, providerCustomerId) =>
      q("set_provider_customer_id", () =>
        db
          .update(c)
          .set({ providerCustomerId })
          .where(and(eq(c.id, customerId), isNull(c.providerCustomerId)))
          .run(),
      ).pipe(Effect.map((result) => rowsChanged(result) > 0)),

    claimCheckout: (input) =>
      q("claim_checkout", () =>
        db
          .update(c)
          .set({
            pendingCheckoutSessionId: null,
            pendingCheckoutPlanId: input.planId,
            pendingCheckoutCurrency: input.currency,
            pendingCheckoutNonce: input.nonce,
            pendingCheckoutStartedAt: input.now,
          })
          .where(
            and(
              eq(c.id, input.customerId),
              input.expectedNonce === null
                ? isNull(c.pendingCheckoutNonce)
                : eq(c.pendingCheckoutNonce, input.expectedNonce),
            ),
          )
          .run(),
      ).pipe(Effect.map((result) => rowsChanged(result) > 0)),

    setCheckoutSession: (input) =>
      q("set_checkout_session", () =>
        db
          .update(c)
          .set({ pendingCheckoutSessionId: input.sessionId })
          .where(and(eq(c.id, input.customerId), eq(c.pendingCheckoutNonce, input.nonce)))
          .run(),
      ).pipe(Effect.map((result) => rowsChanged(result) > 0)),

    abandonCheckout: (input) =>
      q("abandon_checkout", () =>
        db
          .update(c)
          .set(
            input.restore
              ? {
                  pendingCheckoutSessionId: input.restore.sessionId,
                  pendingCheckoutPlanId: input.restore.planId,
                  pendingCheckoutCurrency: input.restore.currency,
                  pendingCheckoutNonce: input.restore.nonce,
                  pendingCheckoutStartedAt: input.restore.startedAt,
                }
              : noPending,
          )
          .where(
            and(
              eq(c.id, input.customerId),
              eq(c.pendingCheckoutNonce, input.nonce),
              isNull(c.pendingCheckoutSessionId),
            ),
          )
          .run(),
      ).pipe(Effect.asVoid),

    clearCheckout: (input) =>
      q("clear_checkout", () =>
        db
          .update(c)
          .set(noPending)
          .where(and(eq(c.id, input.customerId), eq(c.pendingCheckoutSessionId, input.sessionId)))
          .run(),
      ).pipe(Effect.asVoid),

    markTrialUsed: (customerId, at) =>
      q("mark_trial_used", () =>
        db
          .update(c)
          .set({ trialUsedAt: at })
          .where(and(eq(c.id, customerId), isNull(c.trialUsedAt)))
          .run(),
      ).pipe(Effect.asVoid),

    findSubscription: (id) =>
      q("find_subscription", () =>
        db.select().from(s).where(eq(s.providerSubscriptionId, id)).limit(1).all(),
      ).pipe(Effect.map((rows) => (rows[0] ? toSubscription(rows[0]) : null))),

    listSubscriptions: (customerRef) =>
      q("list_subscriptions", () =>
        db.select().from(s).where(eq(s.customerRef, customerRef)).all(),
      ).pipe(Effect.map((rows) => rows.map(toSubscription))),

    upsertSubscription: (write, now) =>
      q("upsert_subscription", () =>
        commitBatch(db, [
          db
            .insert(s)
            .values({ ...write, pastDueSince: write.status === "past_due" ? now : null })
            .onConflictDoUpdate({
              target: s.providerSubscriptionId,
              set: {
                customerRef: sql`excluded.customer_ref`,
                planId: sql`excluded.plan_id`,
                providerPriceId: sql`excluded.provider_price_id`,
                interval: sql`excluded.interval`,
                status: sql`excluded.status`,
                currency: sql`excluded.currency`,
                currentPeriodStart: sql`excluded.current_period_start`,
                currentPeriodEnd: sql`excluded.current_period_end`,
                trialEnd: sql`excluded.trial_end`,
                cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
                fetchStartedAt: sql`excluded.fetch_started_at`,
                // Grace runs from the first time it was seen past due.
                pastDueSince: sql`CASE WHEN excluded.status = 'past_due' THEN COALESCE(${s.pastDueSince}, excluded.past_due_since) ELSE NULL END`,
              },
              // `>=`, so two fetches started in the same millisecond both land;
              // an older one never overwrites a newer one.
              setWhere: sql`excluded.fetch_started_at >= ${s.fetchStartedAt}`,
            }),
          markDirty(write.customerRef, now),
        ]),
      ),

    recordPaidPeriod: (input) =>
      q("record_paid_period", () =>
        commitBatch(db, [
          db
            .update(s)
            .set({ paidPeriodStart: input.start, paidPeriodEnd: input.end })
            .where(
              and(
                eq(s.providerSubscriptionId, input.providerSubscriptionId),
                or(isNull(s.paidPeriodEnd), lt(s.paidPeriodEnd, input.end)),
              ),
            ),
          markDirty(input.customerRef, input.now),
        ]),
      ),

    markReconciled: (id, at) =>
      q("mark_reconciled", () =>
        db.update(s).set({ reconciledAt: at }).where(eq(s.providerSubscriptionId, id)).run(),
      ).pipe(Effect.asVoid),

    listSubscriptionsToReconcile: (sel) =>
      q("list_subscriptions_to_reconcile", () =>
        db
          .select()
          .from(s)
          .where(
            and(
              ne(s.status, "canceled"),
              ne(s.status, "incomplete_expired"),
              or(isNull(s.reconciledAt), lt(s.reconciledAt, sel.attemptedBefore)),
              or(
                and(eq(s.status, "trialing"), lt(s.trialEnd, sel.now)),
                and(ne(s.status, "trialing"), lt(s.currentPeriodEnd, sel.now)),
                and(
                  eq(s.status, "active"),
                  gte(s.currentPeriodStart, sel.unconfirmedFrom),
                  lt(s.currentPeriodStart, sel.unconfirmedTo),
                  or(isNull(s.paidPeriodStart), lt(s.paidPeriodStart, s.currentPeriodStart)),
                ),
              ),
            ),
          )
          // Never-attempted rows first, then the oldest attempt.
          .orderBy(sql`${s.reconciledAt} IS NOT NULL`, asc(s.reconciledAt))
          .limit(sel.limit)
          .all(),
      ).pipe(Effect.map((rows) => rows.map(toSubscription))),

    listGrants: (customerRef) =>
      q("list_grants", () =>
        db
          .select({
            customerRef: g.customerRef,
            featureId: g.featureId,
            source: g.source,
            grantedBy: g.grantedBy,
            expiresAt: g.expiresAt,
          })
          .from(g)
          .where(eq(g.customerRef, customerRef))
          .all(),
      ).pipe(Effect.map((rows) => rows.map((row): GrantRecord => ({ ...row, source: "comp" })))),

    upsertGrant: (grant, now) =>
      q("upsert_grant", () =>
        commitBatch(db, [
          db
            .insert(g)
            .values({ ...grant, createdAt: now })
            .onConflictDoUpdate({
              target: [g.customerRef, g.featureId],
              set: { source: grant.source, grantedBy: grant.grantedBy, expiresAt: grant.expiresAt },
            }),
          markDirty(grant.customerRef, now),
        ]),
      ),

    deleteGrant: (customerRef, featureId, now) => {
      const grant = and(eq(g.customerRef, customerRef), eq(g.featureId, featureId));
      return Effect.gen(function* () {
        // Read first for the answer; the delete and its mark then commit together.
        const found = yield* q("find_grant", () =>
          db.select({ featureId: g.featureId }).from(g).where(grant).limit(1).all(),
        );
        yield* q("delete_grant", () =>
          commitBatch(db, [db.delete(g).where(grant), markDirty(customerRef, now)]),
        );
        return found.length > 0;
      });
    },

    claimEvent: (input) =>
      Effect.gen(function* () {
        const result = yield* q("claim_event", () =>
          db
            .insert(ev)
            .values({
              eventId: input.eventId,
              type: input.type,
              outcome: "processing",
              processingUntil: input.leaseUntil,
              receivedAt: input.now,
            })
            .onConflictDoUpdate({
              target: ev.eventId,
              set: { processingUntil: input.leaseUntil },
              setWhere: and(
                eq(ev.outcome, "processing"),
                or(isNull(ev.processingUntil), lte(ev.processingUntil, input.now)),
              ),
            })
            .run(),
        );
        if (rowsChanged(result) > 0) return "claimed" satisfies EventClaim;
        const rows = yield* q("find_event", () =>
          db
            .select({ outcome: ev.outcome })
            .from(ev)
            .where(eq(ev.eventId, input.eventId))
            .limit(1)
            .all(),
        );
        return rows[0]?.outcome === "processing" ? "held" : "done";
      }),

    finishEvent: (eventId, outcome, token) =>
      q("finish_event", () =>
        db
          .update(ev)
          .set({ outcome, processingUntil: null })
          .where(and(eq(ev.eventId, eventId), eq(ev.processingUntil, token)))
          .run(),
      ).pipe(Effect.asVoid),

    releaseEvent: (eventId, token) =>
      q("release_event", () =>
        db
          .update(ev)
          .set({ processingUntil: null })
          .where(
            and(
              eq(ev.eventId, eventId),
              eq(ev.outcome, "processing"),
              eq(ev.processingUntil, token),
            ),
          )
          .run(),
      ).pipe(Effect.asVoid),

    pruneEvents: (before) =>
      q("prune_events", () => db.delete(ev).where(lt(ev.receivedAt, before)).run()).pipe(
        Effect.map(rowsChanged),
      ),

    acquireAccess: (input) =>
      q("acquire_access", () =>
        db
          .update(c)
          // Each grant of the lease takes a new version, so every decision the
          // hook is handed carries a larger token than the one before, even
          // one that only the passing of time changed.
          .set({ accessLockUntil: input.until, accessVersion: sql`${c.accessVersion} + 1` })
          .where(
            and(
              eq(c.customerRef, input.customerRef),
              or(isNull(c.accessLockUntil), lte(c.accessLockUntil, input.now)),
            ),
          )
          .returning({ version: c.accessVersion })
          .all(),
      ).pipe(Effect.map((rows) => rows[0] ?? null)),

    completeAccess: (input) =>
      q("complete_access", () =>
        db
          .update(c)
          .set({
            accessLockUntil: null,
            nextAccessBoundaryAt: input.boundary,
            accessAppliedVersion: input.version,
          })
          .where(
            and(
              eq(c.customerRef, input.customerRef),
              eq(c.accessLockUntil, input.token),
              eq(c.accessVersion, input.version),
            ),
          )
          .run(),
      ).pipe(Effect.map((result) => rowsChanged(result) > 0)),

    releaseAccess: (input) =>
      q("release_access", () =>
        db
          .update(c)
          .set({ accessLockUntil: null, nextAccessBoundaryAt: dueBy(input.dueAt) })
          .where(and(eq(c.customerRef, input.customerRef), eq(c.accessLockUntil, input.token)))
          .run(),
      ).pipe(Effect.asVoid),

    markAccessDue: (customerRef, dueAt) =>
      q("mark_access_due", () =>
        db
          .update(c)
          .set({ nextAccessBoundaryAt: dueBy(dueAt) })
          .where(eq(c.customerRef, customerRef))
          .run(),
      ).pipe(Effect.asVoid),

    listDueCustomers: (now, limit) =>
      q("list_due_customers", () =>
        db
          .select({ customerRef: c.customerRef })
          .from(c)
          .where(lte(c.nextAccessBoundaryAt, now))
          .orderBy(asc(c.nextAccessBoundaryAt))
          .limit(limit)
          .all(),
      ).pipe(Effect.map((rows) => rows.map((row) => row.customerRef))),

    forgetCustomer: (customerRef) =>
      Effect.gen(function* () {
        const row = yield* findCustomerWhere("find_customer", eq(c.customerRef, customerRef));
        if (row === null) return null;
        yield* q("forget_customer", () =>
          commitBatch(db, [
            db.delete(g).where(eq(g.customerRef, customerRef)),
            db.delete(s).where(eq(s.customerRef, customerRef)),
            db.delete(c).where(eq(c.customerRef, customerRef)),
          ]),
        );
        return { providerCustomerId: row.providerCustomerId };
      }),
  };
}
