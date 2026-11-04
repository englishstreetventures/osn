# @shared/billing

## 0.1.1

### Patch Changes

- Updated dependencies [ad20023]
  - @shared/observability@0.19.3

## 0.1.0

### Minor Changes

- 432200d: Add `@shared/billing`: code-defined plans and features, Stripe subscriptions over `fetch` (API version `2025-03-31.basil`, no SDK), feature access from the database, and a webhook that verifies, claims, re-fetches and applies access under a per-customer lease. `status()` exposes the paid period an invoice confirmed, so a trial or an unpaid renewal never counts as paid. `syncPlans` writes the plans to Stripe and is a dry run unless told to apply. Tables come from `createBillingSqliteSchema({ prefix })` for D1 and bun:sqlite; the consumer owns the migrations.

  `@shared/observability` redacts the billing provider's `secretKey` and `webhookSecret`, and the Stripe customer fields that invoices, Checkout sessions and customer objects carry: `customer_details`, `customer_address`, `customer_email`, `customer_name`, `customer_phone`, `customer_shipping`, `customer_tax_ids`, `address` and `tax_ids`.

### Patch Changes

- Updated dependencies [432200d]
  - @shared/observability@0.19.2
