---
title: "@shared/billing — plans, subscriptions and feature access"
aliases:
  - billing
  - subscriptions
  - shared billing
tags:
  - shared
  - billing
  - stripe
  - payments
status: current
related:
  - "[[backend-patterns]]"
  - "[[d1-limits]]"
  - "[[free-tier-limits]]"
  - "[[stripe-webhooks]]"
  - "[[cire-upgrades]]"
  - "[[shared/observability/overview]]"
  - "[[testing-patterns]]"
packages:
  - "@shared/billing"
last-reviewed: 2026-11-04
---

# @shared/billing

Recurring billing for a Worker: plans and features declared in code, Stripe
subscriptions over `fetch` (no `stripe` SDK, API version `2025-03-31.basil`),
feature access answered from our own database, and a webhook that keeps that
database in step. The core is Effect v4; `./promise` serves an app that does
not use Effect. Storage is Drizzle on SQLite: Cloudflare D1 deployed,
`bun:sqlite` locally.

**Consumers.** None yet. Cire is the first planned one: vendor subscriptions,
epic englishstreetventures/osn#1173, wired in englishstreetventures/osn#1175.
One-off purchases (Checkout `mode=payment`) and moving Cire's wedding upgrades
onto the package are englishstreetventures/osn#1180; the introductions
allowance ledger that reads `status()` is englishstreetventures/osn#1485.

**What it does not hold.** No wedding, vendor, listing or introduction
concept. A consumer's own states — a directory listing's moderation status, a
lead's qualification, a usage counter — stay in the consumer's tables and are
never written into billing tables or read by `check()`. Connect (money moving
on someone else's Stripe account) never goes through it: no call sets
`Stripe-Account`, and the webhook refuses any event naming an account.

## Entry points

| Import | Holds | Worker-safe |
|---|---|---|
| `@shared/billing` | `defineFeature`, `definePlan`, `createBilling` (Effect), errors, types | yes |
| `@shared/billing/promise` | `createBilling` returning Promises; `run` required | yes |
| `@shared/billing/stripe` | `createStripeProvider`, `createStripeRequest`, `encodeStripeForm`, `verifyStripeWebhook`, `StripeError`, `StripeSignatureError`, constants | yes |
| `@shared/billing/storage/sqlite-schema` | `createBillingSqliteSchema({ prefix })` — drizzle only, so drizzle-kit can load it | yes |
| `@shared/billing/storage/sqlite` | `createSqliteBillingStorage({ db, schema })` | yes |
| `@shared/billing/webhook-body` | `readBoundedText`, `MAX_EVENT_BYTES` (64 KB) | yes |
| `@shared/billing/elysia` | `billingWebhookRoute(billing, { path, run })` | yes |
| `@shared/billing/sync` | `syncPlans` — script only, never at request time | yes (unused there) |

The Stripe request helper, the verifier and `readBoundedText` are copies of
Cire's (`cire/api/src/services/stripe.ts`, `cire/api/src/lib/webhook-body.ts`),
with three changes: GET parameters go in the query string, arrays encode as
`key[0]=` (the form stripe-node sends), and one timeout covers the fetch and
the body read. englishstreetventures/osn#1175 moves Cire onto them.

## Plans and features

```ts
const workspace = defineFeature({ id: "workspace" });

export const plans = [
  definePlan({
    id: "monthly",               // names the Stripe product billing_monthly
    name: "Monthly",
    group: "workspace",          // at most one live subscription per group
    lookupKey: "workspace_monthly_v1",
    trialDays: 30,
    taxCode: "txcd_10103001",    // optional; omitted, Stripe Tax uses the account preset
    features: [workspace],
    price: {
      interval: "month",
      defaultCurrency: "AUD",
      amounts: { AUD: 4900, USD: 3500 },   // minor units; read only by syncPlans
      taxBehavior: "exclusive",            // read only by syncPlans; fixed at Stripe once set
    },
  }),
] as const;
```

Plan and feature ids are inferred as literal types, so `checkout({ planId })`
and `check(ref, featureId)` reject a misspelt id at compile time. Plan ids are
unique per Stripe account (they name products), as are lookup keys.

At run time Stripe is the source of truth for prices: `catalogue()` reads every
plan's price back by lookup key, with each currency's amount and the price's
`tax_behavior`, and caches it for five minutes.

## Wiring a consumer

1. **Tables.** Re-export them as named top-level exports of the consumer's
   schema module — drizzle-kit and any DDL lockstep test only find top-level
   tables — and generate the migration with the consumer's own `db:generate`:

   ```ts
   export const { billingCustomers, billingSubscriptions, billingWebhookEvents, billingGrants } =
     createBillingSqliteSchema({ prefix: "billing_" });
   ```

   The consumer also adds the tables to its data map ([[data-map]]) and a
   retention row ([[retention]]). They hold no address, tax id, email or
   amount: customer refs, Stripe ids, statuses, plan ids and period times. Its
   account-deletion path calls `forgetCustomer({ customerRef })`. Under the
   customer's access lease, that hands `onAccess` a final decision denying every
   feature, then deletes the customer's grants, subscriptions and row in one
   batch. It answers the Stripe customer id it held (`null` when there was no
   row), so the consumer can delete that customer at Stripe too — which cancels
   its subscriptions — or keep it under its tax-record basis. While the lease
   stays busy or the hook fails it deletes nothing and fails as `grant` does.

2. **One instance per isolate**, built where the app graph is built:

   ```ts
   const billing = createBilling({
     plans,
     storage: createSqliteBillingStorage({ db, schema }),
     provider: createStripeProvider({ secretKey, webhookSecret }),
     returnOrigins: ["https://app.example.com"], // where Checkout and the portal may send the buyer back
     tax: { automatic: true, collectTaxIds: true, requireTaxId: false },
     portalConfiguration,             // the id syncPlans printed
     hooks: { onAccess: (decision, { signal }) => applyListing(decision, signal) },
   });
   ```

   Every method returns an Effect with no requirements, so it runs on the
   consumer's `ManagedRuntime`. With `./promise`, pass that runtime's
   `runPromise` as `run`: it carries the logger that redacts.

   `createBilling` throws at boot on a configuration that would weaken a
   check: a `policy` or `tuning` number that is not finite (or, for tuning, not
   above zero), an access lease no longer than the hook timeout plus the
   budget, an event lease no longer than that plus one provider call, or a
   `returnOrigins` entry that is not a bare origin. A key passed as `undefined`
   keeps its default.

3. **The webhook** on its own endpoint with its own signing secret, mounted only
   when the secret is set: `billingWebhookRoute(billing, { path, run })`. Exempt
   the path from any CSRF origin guard (Stripe sends no `Origin`). Subscribe the
   Stripe endpoint ("Your account", not connected accounts) to:
   `checkout.session.completed`, `checkout.session.expired`,
   `customer.subscription.created`, `.updated`, `.deleted`, `.paused`,
   `.resumed`, `.trial_will_end`, `invoice.paid`, `invoice.payment_failed`.
   Anything else is acknowledged and ignored.

4. **Cron**, in this order, in one handler: `reconcile({ limit })`, then
   `sweepAccess({ limit })`, then `pruneWebhookEvents({ before, limit })` —
   reconcile first, so a lost renewal webhook is repaired before anyone is
   lapsed. A prune that answers `limit` left older claims for the next run.

5. **At the enforcement flip**, `reapplyAll({ customerRefs })` over every
   customer the consumer gates, so a customer with no billing row is told it has
   no access.

## Access

`check(ref, featureId)` and `status(ref)` read the database only. The rule is
a pure function (`src/policy.ts`):

| Status | Access |
|---|---|
| `trialing` | until `trial_end` + leeway |
| `active` | until the current period's end + leeway |
| `past_due` | until first seen past due + grace |
| any other, or unknown | none (an unknown status is logged) |

Defaults: grace 7 days, leeway 48 hours, one trial per customer. A grant
(`grant({ customerRef, featureId, source: "comp", grantedBy, expiresAt })`)
overrides the table until it expires; `expiresAt: null` never expires.

### Applying access

`onAccess(decision, { signal })` is the consumer's write — Cire's will set a
listing live or lapsed. It is idempotent and always given the **current**
decision for every feature, never a delta, from every webhook delivery, every
sweep visit, reconcile, `grant`, `revokeGrant` and `reapplyAll`.

It runs under a per-customer lease (`access_lock_until`). Every write access
depends on bumps the customer's `access_version` in the same D1 batch, and so
does taking the lease. The holder keeps the version the lease gave it and
releases only if it has not moved, otherwise it reads again and calls the hook
again. So a write that lands while a decision is being applied is never left
behind it. A caller that finds the lease taken waits (up to 3 s), polling by
reading the row alone from 100 ms, doubling up to 800 ms, and takes the lease
again only once the row shows it free; a caller after a write stops early once
a completed application covers that write. The sweep never waits: it skips a
customer whose lease is held, and one it cannot apply (the hook fails or times
out) is due again 15 minutes later, behind the customers not yet tried —
unless a write landed during the attempt, which keeps it due at once.

`decision.version` is a fencing token: every call to the hook carries a larger
one than the call before, including a call that only time changed — a grant
expiring or grace running out, which the sweep applies with no write — and the
first call for a ref created again after `forgetCustomer`. Each version is one
more than the last and never below the clock (1,000 per millisecond), so it
does not restart when a row does. A hook
whose write must never be overtaken by an older one stores it and writes only a
larger one (`WHERE applied_version < :version`). The hook runs under a 3 s timeout; past
it the signal aborts, the lease is kept until it expires (30 s), so a write the
hook is still making cannot land after a newer holder's, and the customer is
left due for the sweep. Every timing is a `tuning` option (`DEFAULT_TUNING` in
`src/billing/types.ts`), sized so a webhook fits inside Stripe's 20 s.

When a call cannot apply — the lease stayed busy, the hook failed or timed
out — the customer's `next_access_boundary_at` is left due: the webhook answers
500 so Stripe redelivers, and the next sweep visits the row in any case.

### Paid periods

For an allowance that mints units per paid period, `status()` gives each
subscription its `paidPeriod` (`{ id, start, end }`, id
`<subscription id>:<period start, unix seconds>`) and `currentPeriodPaid`.
A period is confirmed only by an invoice that:

- is `paid`, with `total` (after discounts and tax) above zero;
- has `billing_reason` `subscription_create`, `subscription_cycle` or
  `subscription_update`;
- holds a line for this subscription with `parent.type =
  subscription_item_details`, `proration = false` and `amount > 0`
  (several: the latest `period.end`).

So a trial (its line is 0, even beside a paid one-off item), a 100%-off coupon
(total 0), a mid-period upgrade (proration lines) and a renewal whose invoice is
not paid yet all leave `currentPeriodPaid` false. An early trial end or a
billing-anchor reset bills a full non-proration period and is confirmed. The
period comes from the signed `invoice.paid` body, which is final for an invoice;
reconcile reads `latest_invoice` when a period is still unconfirmed. Nothing
from the invoice is stored beyond the period. A refund does not unconfirm a
period: the consumer's ledger owns refunds.

## The webhook

1. `content-length` over 64 KB → 400; the body is read with the same cap as it
   streams.
2. HMAC verified: v1 signatures, 300 s tolerance, every candidate compared with
   no early exit → 400 on failure, with the reason.
3. An event with `account` set (Connect) → 200 `refused_connect`; nothing read
   or written.
4. A type outside the list above, or a Checkout session whose `mode` is not
   `subscription` → 200 `ignored`.
5. The event id is claimed under a 60 s lease: already done → 200 `duplicate`;
   lease held → 500 so Stripe retries; lease expired → taken over. The lease's
   expiry is the claim's token: a delivery that overran its lease can no longer
   release or finish the event under the one that took it over.
6. The subscription is re-fetched from Stripe; the event body is never trusted
   for state. Price → plan by `price.metadata.plan_id`, else the product
   `billing_<planId>`, never by lookup key (a new price takes the key over and
   would strand existing subscribers).
7. The row is upserted with `WHERE excluded.fetch_started_at >= stored`, the
   timestamp taken before the request goes out, so a slow fetch of older state
   never overwrites a newer one. `>=` lets two fetches started in the same
   millisecond both land.
8. Access is applied; the event is marked done → 200.

Any storage, provider, lease or hook failure in steps 6–8 releases the claim and
answers 500. A subscription whose Stripe customer is not one this package made
(another product on the account, a reset test account) is ignored with a 200:
checkout stores the Stripe customer id before any session exists, so only those
are unknown.

## Checkout and the portal

`checkout({ customerRef, planId, currency, successUrl, cancelUrl })` → `{ url,
reused }`. Both URLs, and the portal's `returnUrl`, must be on one of
`returnOrigins`, or the call fails `ReturnUrlRefused` before any write or Stripe
call: build them on the server, never from the request. It refuses `AlreadySubscribed` while the customer holds a non-ended
subscription in the plan's group, `CurrencyNotOffered` when the price has no
amount in that currency, and `PlanUnavailable` when Stripe has no active price
under the lookup key (not synced) or that price names another plan. The form:

| Parameter | When |
|---|---|
| `mode=subscription`, `customer`, `client_reference_id`, `line_items[0][price]` (from the lookup key), `line_items[0][quantity]=1`, `currency` (always explicit, lower case), `success_url`, `cancel_url` | always |
| `subscription_data[trial_period_days]` | only when the customer is trial-eligible: Stripe's minimum is 1 |
| `automatic_tax[enabled]=true`, `customer_update[address]=auto` | `tax.automatic` |
| `tax_id_collection[enabled]=true`, `customer_update[name]=auto` | `tax.collectTaxIds` |
| `tax_id_collection[required]=if_supported` | `tax.requireTaxId` (needs `collectTaxIds`) |

`billing_address_collection` is not sent: its default, `auto`, collects the
fields Stripe Tax needs.

One checkout is pending per customer. Its plan, currency and a nonce sit on the
customer row, and the nonce is in the idempotency key
(`billing-checkout-<bcus id>-<nonce>`), so concurrent requests for the same plan
and currency reach the same session and get the same URL. An open session for
the same plan and currency is reused; a different one is expired and replaced
under a new nonce; a completed one whose webhook has not landed answers
`CheckoutInFlight`. The Stripe customer is created once, keyed
`billing-customer-<bcus id>`, with only `metadata[billing_customer]`; a 409 on
that key is replayed.

`portal({ customerRef, returnUrl })` opens a portal session on the
configuration `syncPlans` manages; `NoBillingCustomer` before any checkout,
`ReturnUrlRefused` for a `returnUrl` off `returnOrigins`.

## Cron costs

Size `limit` against the invocation's budget — on the Workers Free plan 50 D1
queries and 50 external subrequests ([[free-tier-limits]]), shared with
whatever else the cron runs.

| Call | Per item |
|---|---|
| `reconcile` | 1 Stripe call, 2 when the current period is unconfirmed (the latest invoice); about 10 queries; the hook's own. A busy lease adds 1 read per poll, about 6 in its 3 s |
| `sweepAccess` | about 4 queries, plus one listing per run; the hook's own. A lease taken under it costs 1 query and no wait |
| `reapplyAll` | about 6 queries per ref; the hook's own. The list is the bound. A busy lease adds about 6 reads |
| `pruneWebhookEvents` | 1 query per run, writing up to 3 rows per claim deleted (the row and two indexes), so up to 3 × `limit` |

The reconcile selection reads only due rows: each of its three branches (a
trial past its end, a live period past its end, an unconfirmed recent period)
seeks its own index, and a test reads the real query's plan.

`reconcile` picks non-ended subscriptions whose period (trial end while
trialing) has passed, and active ones whose current period started 2 hours to 7
days ago and is unconfirmed. Each pick is stamped `reconciled_at` before its
call and skipped for an hour, so failing rows cannot hold the head of the queue.
A subscription Stripe no longer has is marked `canceled`.

## Storage

`BillingStorage` (`src/storage/port.ts`) is an interface of Effect-returning
methods, so a Postgres adapter can sit beside the SQLite one. The SQLite
adapter takes `@shared/db-utils`'s schema-less `Db`, which both drivers'
handles are, and uses that package's `commitBatch` and `rowsChanged`: a data
write and its version bump go out as one batch, atomic on D1 and in that order
on bun:sqlite.

| Table | Key | Holds |
|---|---|---|
| `<prefix>customers` | `id` (`bcus_…`); `customer_ref` and `provider_customer_id` unique | trial used, the pending checkout, access lease, version, applied version, next boundary |
| `<prefix>subscriptions` | `provider_subscription_id` | customer ref, plan, price, interval, status, currency (from the subscription), period, trial end, past due since, cancel at period end, paid period, `fetch_started_at`, `reconciled_at` |
| `<prefix>webhook_events` | `event_id` | type, outcome, the claim's lease, received at. No payload |
| `<prefix>grants` | (`customer_ref`, `feature_id`) | source, granted by, expiry |

`forgetCustomer` deletes a customer's grants, subscriptions and row in one
batch, children first, since both child tables reference the customer row and
D1 enforces foreign keys; each delete holds only while the erasure's lease
does. The same foreign keys refuse a subscription or grant written for a
customer already erased, so an in-flight webhook or reconcile cannot bring the
rows back. A revoked grant and its version bump also go out as one batch.

The same contract suite (`tests/storage/contract.ts`) runs on bun:sqlite under
vitest and on Miniflare D1 under `bun test` (`test:d1`), with DDL from
drizzle-kit's own generator.

## syncPlans

```bash
STRIPE_SECRET_KEY=sk_test_… bun run --cwd shared/billing sync-plans -- --plans <module exporting `plans`>
```

A dry run: it reads Stripe and prints each plan's product and price changes —
per currency, such as `NZD: missing → 5200` or `GBP: 3000 → removed` — and the
portal configuration's. Add `--apply` to write; any key that is not a test key
(`sk_test_`, `rk_test_`) also needs `--live`, so a key of a shape the script
does not know is treated as live.
`--plans` resolves from `shared/billing`. Per plan it keeps:

- a product `billing_<planId>` with `metadata.plan_id` and the plan's
  `tax_code`;
- one price under the lookup key with every non-default currency in
  `currency_options`, `tax_behavior` on the price and each option, and
  `metadata.plan_id`. A changed amount, currency set, interval or tax behaviour
  makes a new price with `transfer_lookup_key=true`; existing subscribers keep
  the old one, which still maps by its metadata. Every create sends
  `transfer_lookup_key=true`, since an archived price can still hold the key.

A product or price it would touch that names another plan is a conflict, and a
conflict stops every write. It also keeps one portal configuration, found by
`metadata.managed_by=billing-sync` and updated in place: customer updates of
address and tax id, invoice history, payment-method updates, cancellation at
period end, plan switching off (it would offer a stale price list). It prints
the configuration's id for the consumer's `portalConfiguration` setting.

## Stripe parameters, checked

Checked against docs.stripe.com on 2026-11-04. The basil-versioned pages were
read for subscriptions, invoices and invoice lines; the Checkout, Price, Product
and portal pages were read at their current version.

| Question | Finding | Source |
|---|---|---|
| `currency` on a subscription Checkout with a `currency_options` price | the parameter exists; the reference ties no rule to subscription mode. **Confirm on the first test-mode checkout** | [Checkout create](https://docs.stripe.com/api/checkout/sessions/create) |
| `subscription_data[trial_period_days]` | "Has to be at least 1", so it is sent only to an eligible customer | same |
| `customer_update[address]` / `[name]` with an existing customer | documented as the way to write Checkout's address and name back, not stated as required | [Tax ids in Checkout](https://docs.stripe.com/tax/checkout/tax-ids) |
| `tax_id_collection[required]` | `if_supported` or `never` | Checkout create |
| `billing_address_collection` | default `auto` collects the minimum Stripe Tax needs | Checkout create |
| `lookup_keys` on a price list | at most 10 per call; the package chunks | [List prices](https://docs.stripe.com/api/prices/list) |
| `currency_options` in a list | includable: absent unless `expand[]=data.currency_options` | [Price object](https://docs.stripe.com/api/prices/object) |
| `tax_behavior` | "Once specified as either inclusive or exclusive, it cannot be changed" | [Create price](https://docs.stripe.com/api/prices/create) |
| Product custom `id`, `tax_code` | both allowed; no `tax_code` means the account's preset | [Create product](https://docs.stripe.com/api/products/create), [tax codes](https://docs.stripe.com/tax/tax-codes) |
| SaaS tax code | `txcd_10103001` "Software as a service (SaaS) - business use". The package sets no default; the consumer picks | tax codes |
| Portal configuration | `features` required; list filters only `active`/`is_default`, so the managed one is found by metadata client-side; updated at `POST /v1/billing_portal/configurations/:id`; cancel `mode` defaults to `at_period_end` | [Create portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create) |
| Basil subscription period | on `items.data[].current_period_start/end`; statuses include `paused` | [basil changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end) |
| Basil invoice | subscription at `parent.subscription_details.subscription`; lines at `parent.subscription_item_details.{subscription, proration}`; `amount` is before discounts | [Invoice line item](https://docs.stripe.com/api/invoice-line-item/object) |
| A second currency for one customer | no error code distinguishes it on the error-codes page | [Error codes](https://docs.stripe.com/error-codes) |
| Array encoding | stripe-node sends `key[0]=` | [stripe-node `src/utils.ts`](https://github.com/stripe/stripe-node/blob/master/src/utils.ts) |

## Decisions

- **No `CurrencyLocked` error.** englishstreetventures/osn#1174 asked for one
  mapped from Stripe's refusal of a second currency, or none if Stripe names no
  distinguishing code. It names none, and no test-mode key was available to
  capture the real refusal; `AlreadySubscribed` covers the usual path. If a
  test-mode checkout in a second currency is refused, it surfaces as a
  `BillingProviderError` carrying Stripe's code — map that code then.
- **`taxBehavior` lives on the plan**, read only by `syncPlans`, beside the
  amounts. Runtime reads it back from Stripe.
- **The price cache is per instance**, a plain value with a TTL, not
  module-level: two instances with different keys can never read each other's
  prices. It is never an `Effect.cached`, `Deferred` or `Semaphore`: a request
  woken from another request's fiber would ride that request's D1 session
  (`cire/api/src/db/d1-session.ts`).
- **`commitBatch` from `@shared/db-utils`, no private batch helper.** It takes
  the schema-less `Db` that Cire's handle already is, so nothing rejects a
  consumer's schema.
- **Invoices are read, never stored.** Confirming a paid period needs the
  invoice; its customer fields reach the Worker in the `invoice.paid` body and
  are on the redaction list ([[logging]]).

## Observability

- **Spans:** `billing.checkout`, `.portal`, `.catalogue`, `.check`, `.status`,
  `.grant`, `.revoke_grant`, `.webhook.handle` with `.verify` and `.apply`,
  `.access.apply`, `.reconcile`, `.sweep`, `.reapply`, `.sync`,
  `billing.stripe.<op>`, `billing.storage.<operation>`. Outbound calls go
  through `instrumentedFetch`.
- **Metrics** (`src/metrics.ts`, [[shared/observability/metrics|metrics]]):
  `osn.billing.checkout.started`, `.portal.opened`, `.webhook.received`,
  `.subscription.transitions`, `.access.checked`, `.access.applied`,
  `.provider.request.duration`, `.reconcile.subscriptions`. Every attribute is
  a closed union; an event type or status outside the known set is `other`.
  No id is ever an attribute. On Workers the meter records nothing, so every
  failure is also logged.
- **Never logged:** the secret key, the webhook secret, the `stripe-signature`
  header, the body. Errors carry Stripe's `code`, never its message.

## Known limits

These fail closed — no access or no paid period where one might be due — and
are repaired by the next delivery, reconcile or sweep, or not at all:

- An `invoice.paid` lost while the subscription is `past_due`, paid more than
  7 days into the period, is never read; that period stays unconfirmed.
- A paused subscription whose period does not move is re-fetched once per
  reconcile run that reaches it.
- A webhook whose access application could not finish answers 500; in a
  Stripe sandbox, retries stop after three attempts over a few hours
  ([[stripe-webhooks]]), and then only the sweep repairs the row.
