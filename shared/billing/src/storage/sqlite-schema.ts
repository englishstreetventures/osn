/**
 * The billing tables, for SQLite (bun:sqlite locally, Cloudflare D1 deployed).
 *
 * The package owns their shape; the consumer owns the migrations. Re-export the
 * four tables as NAMED TOP-LEVEL exports of the consumer's schema module —
 * drizzle-kit (and a DDL lockstep test) only discover top-level tables:
 *
 *   export const { billingCustomers, billingSubscriptions, billingWebhookEvents, billingGrants } =
 *     createBillingSqliteSchema({ prefix: "billing_" });
 *
 * This module imports drizzle only, so drizzle-kit can load it.
 *
 * Times are integer milliseconds (`timestamp_ms`). No payload, address, tax id
 * or invoice amount is stored.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export interface BillingSqliteSchemaOptions {
  /** Prepended to every table and index name. Default `billing_`. */
  readonly prefix?: string;
}

const ms = (name: string) => integer(name, { mode: "timestamp_ms" });

/**
 * A subscription that has not ended for good. Written with literals, never
 * bound values, so SQLite can match a query's term to the partial index's.
 */
export const LIVE_STATUS = (status: AnySQLiteColumn): SQL =>
  sql`${status} NOT IN ('canceled', 'incomplete_expired')`;

export function createBillingSqliteSchema(options: BillingSqliteSchemaOptions = {}) {
  const p = options.prefix ?? "billing_";

  const billingCustomers = sqliteTable(
    `${p}customers`,
    {
      /** `bcus_…`: the package's own id, used in Stripe idempotency keys and metadata. */
      id: text("id").primaryKey(),
      /** The consumer's id for whoever pays (an organisation, a user). */
      customerRef: text("customer_ref").notNull().unique(),
      providerCustomerId: text("provider_customer_id").unique(),
      trialUsedAt: ms("trial_used_at"),
      pendingCheckoutSessionId: text("pending_checkout_session_id"),
      pendingCheckoutPlanId: text("pending_checkout_plan_id"),
      pendingCheckoutCurrency: text("pending_checkout_currency"),
      pendingCheckoutNonce: text("pending_checkout_nonce"),
      pendingCheckoutStartedAt: ms("pending_checkout_started_at"),
      /** When a decision changes with no write; the sweep visits rows at or past it. */
      nextAccessBoundaryAt: ms("next_access_boundary_at"),
      /** The per-customer access lease; its value is also the holder's token. */
      accessLockUntil: ms("access_lock_until"),
      /** Bumped by every write access depends on, so a lease holder sees one land. */
      accessVersion: integer("access_version").notNull().default(0),
      /** The version the last completed application decided at; a waiter whose write it covers can stop. */
      accessAppliedVersion: integer("access_applied_version").notNull().default(0),
      createdAt: ms("created_at").notNull(),
    },
    (t) => [index(`${p}customers_boundary_idx`).on(t.nextAccessBoundaryAt)],
  );

  const billingSubscriptions = sqliteTable(
    `${p}subscriptions`,
    {
      providerSubscriptionId: text("provider_subscription_id").primaryKey(),
      customerRef: text("customer_ref").notNull(),
      /** `NULL` when the subscription's price maps to no plan: it grants nothing. */
      planId: text("plan_id"),
      providerPriceId: text("provider_price_id").notNull(),
      /** The price's own recurring interval, as Stripe reports it. */
      interval: text("interval"),
      status: text("status").notNull(),
      /** Upper-case, from the subscription itself. */
      currency: text("currency").notNull(),
      currentPeriodStart: ms("current_period_start"),
      currentPeriodEnd: ms("current_period_end"),
      trialEnd: ms("trial_end"),
      /** First seen `past_due`; cleared when it leaves. Grace runs from here. */
      pastDueSince: ms("past_due_since"),
      cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
        .notNull()
        .default(false),
      /** The latest period an invoice confirmed paid. */
      paidPeriodStart: ms("paid_period_start"),
      paidPeriodEnd: ms("paid_period_end"),
      /** Taken BEFORE the fetch was sent; an older fetch never overwrites a newer one. */
      fetchStartedAt: ms("fetch_started_at").notNull(),
      /** The last reconcile attempt, whatever its outcome. */
      reconciledAt: ms("reconciled_at"),
    },
    (t) => [
      index(`${p}subscriptions_customer_idx`).on(t.customerRef),
      // One index per branch of the reconcile selection, so each seeks to the
      // rows that are due instead of reading every subscription ever made.
      index(`${p}subscriptions_trial_due_idx`).on(t.status, t.trialEnd),
      index(`${p}subscriptions_period_due_idx`).on(t.currentPeriodEnd).where(LIVE_STATUS(t.status)),
      index(`${p}subscriptions_unconfirmed_idx`).on(t.status, t.currentPeriodStart),
      foreignKey({
        name: `${p}subscriptions_customer_fk`,
        columns: [t.customerRef],
        foreignColumns: [billingCustomers.customerRef],
      }),
    ],
  );

  const billingWebhookEvents = sqliteTable(
    `${p}webhook_events`,
    {
      eventId: text("event_id").primaryKey(),
      type: text("type").notNull(),
      /** `processing` while claimed; `processed` or `ignored` once done. */
      outcome: text("outcome").notNull(),
      /** The claim's lease. Past it, a redelivery may take the event over. */
      processingUntil: ms("processing_until"),
      receivedAt: ms("received_at").notNull(),
    },
    (t) => [index(`${p}webhook_events_received_idx`).on(t.receivedAt)],
  );

  const billingGrants = sqliteTable(
    `${p}grants`,
    {
      customerRef: text("customer_ref").notNull(),
      featureId: text("feature_id").notNull(),
      source: text("source").notNull(),
      grantedBy: text("granted_by").notNull(),
      /** `null` is a grant with no expiry. */
      expiresAt: ms("expires_at"),
      createdAt: ms("created_at").notNull(),
    },
    (t) => [
      primaryKey({ name: `${p}grants_pk`, columns: [t.customerRef, t.featureId] }),
      foreignKey({
        name: `${p}grants_customer_fk`,
        columns: [t.customerRef],
        foreignColumns: [billingCustomers.customerRef],
      }),
    ],
  );

  return { billingCustomers, billingSubscriptions, billingWebhookEvents, billingGrants };
}

export type BillingSqliteSchema = ReturnType<typeof createBillingSqliteSchema>;
