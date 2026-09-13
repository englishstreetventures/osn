---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
---

Correctness pass over the cash-gift path before it ships.

`ContributionPatch` admitted only four fields, which left the four FX columns
on `registry_contributions` unwritable by any code path; it now carries the
settlement fields as well.

The contributions total summed every succeeded row regardless of currency and
rendered the result as money, so a wedding taking gifts in two currencies saw
yen added to dollars. It now groups on `coalesce(primary_currency, currency)`
and returns a per-currency total with a residual count, and the host portal
renders that instead of one number.

Nothing read the connected account's settlement currency. `StripeAccount` now
carries `default_currency`, `applyStripeAccountState` records it, and
`PUT /registry/settings` refuses a currency the connected account cannot settle
with a `currency_mismatch` 409 rather than letting the mismatch surface as a
Checkout failure the couple cannot explain.

A partial refund did nothing at all: the webhook returned an outcome string
nobody read and the row stayed `succeeded` at its full amount. `charge.refunded`
now records the refunded amount on the row. The write is monotonic, because
`amount_refunded` is cumulative and deliveries can arrive out of order, and a
partial refund that carries no usable amount logs at warning rather than
guessing — the column stays NULL, which honestly means "not recorded". That
column lands on all four schema surfaces: the migration, `schema.ts`, the `DDL`
mirror the `bun:sqlite` tests run on, and the Drizzle snapshot.

The organiser Stripe panel had a test file sitting beside its source, which the
vitest config's `include` glob never matched — so none of it had ever run. It
moves to `tests/components/` and gains cover for the three account states and
their button labels, the failed hand-check, the re-read after a refused save,
and the one-shot live read surviving a remount.

Three webhook comments named migrations 0059 and 0060, neither of which exists
since the squash. They name `0058_gift_summary_and_stripe_state.sql` now.
