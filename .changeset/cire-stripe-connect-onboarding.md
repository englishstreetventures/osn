---
"@cire/api": patch
---

Connect a couple's Stripe account, so gifts of money can land in their bank
rather than ours.

This is the first half of cash gifts: onboarding and the account webhook. The
guest-facing "give money" surface and hosted Checkout follow on top of it.

**The couple are the merchant of record.** Gifts will be direct charges on their
own connected account, so the money goes from the guest's card to their bank and
cire never holds it. Holding gift funds, even in transit, is money transmission —
that is the whole reason the integration is Connect rather than a platform
checkout.

**No `stripe` package.** Three REST calls and a signature check over `fetch`
(`services/stripe.ts`). The official SDK is built around Node's http stack, and
cire-api ships inside a 1MB compressed Worker budget it already shares with
Elysia, Drizzle and Effect. A trade worth re-running if this file grows past the
handful of calls the gift flow needs — not a principle.

**Routes.** `POST …/registry/stripe/session` creates the connected account
(Express; `card_payments` + `transfers`) if there is not one, then mints a hosted
onboarding link; `POST …/registry/stripe/refresh` does one live account read and
caches it, for the moment a couple come back from onboarding ahead of the
webhook. Both are **owner-only**: every other registry write is `weddingEditor`,
because adding a gift is ordinary help, but this names the bank account the money
lands in.

**Create-or-resume, never create-again.** Onboarding is a form people abandon.
The route reuses any account already on the settings row, `stripe_account_id` is
written through a `coalesce` so a second create can only ever fill a null, and
Stripe's idempotency key is the second belt against a double-tapped button. A
second connected account for one couple is the failure that needs a human at
Stripe to unpick.

**`POST /api/stripe/webhook`** verifies every delivery and handles
`account.updated`, caching the two capability booleans. The check takes the raw
request text (a parsed-and-reserialised body has already lost the property being
checked), compares without a length- or value-dependent early exit, accepts any
of several `v1` digests so a secret can be rotated, and refuses anything outside
a 300-second window — a valid signature is valid forever, and without a window a
captured delivery can be replayed at any time against the handler that records
money. An event this product does not act on is acknowledged, not refused: the
endpoint belongs to the platform account, and a non-2xx buys days of retries.

**Intent and capability stay different columns.** `cash_gifts_enabled` is the
couple's decision, `stripe_charges_enabled` is Stripe's. The webhook never
touches the first, and `PUT /registry/settings` still refuses to enable cash
gifts while Stripe cannot take a charge.

**Both halves are key-optional, independently.** No `STRIPE_SECRET_KEY` ⇒ the
onboarding routes are not mounted, so a deployment without a Stripe account has
no payment surface rather than a broken one. No `STRIPE_WEBHOOK_SECRET` ⇒ the
webhook route does not exist, because nothing else authenticates it. Ships inert
until both secrets are set — see `wrangler.toml`.
