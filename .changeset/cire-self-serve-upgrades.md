---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
---

Self-serve upgrade checkout: a cire host can buy a locked module (`vendors`,
`registry`) instead of waiting for an operator to run `grant-entitlement.ts`.
Pressing Upgrade on the faded nav row opens a dialog that prices the module
from Stripe, starts a platform Checkout, and the entitlement is granted by a
signature-verified webhook.

Two Stripe relationships now exist and are deliberately kept apart. Gifts stay
Connect — the couple are the merchant of record and the charge is direct on
their own account. An upgrade is the opposite: cire is the merchant, so it has
its own endpoint (`/api/stripe/platform-webhook`) with its own signing secret.
A Stripe endpoint is scoped either to the platform or to connected accounts and
each carries a different secret, so an upgrade branch inside the Connect route
would have been a branch no event could reach.

New tables (migration 0060): `wedding_upgrade_purchases`, because
`wedding_entitlements` is keyed (wedding, entitlement) with
`onConflictDoNothing` and a second purchase of a held key would vanish with no
record that money moved; and `platform_sales`, deliberately outside the wedding
cascade, since the record of money cire took must not die with the wedding row.

No money amount is stored in the repository — a catalogue entry names a Stripe
Price id supplied per deployment and the amount is read back from Stripe. Both
halves are key-optional and fail-closed: no `STRIPE_SECRET_KEY` and the routes
are not mounted; no Price for a key and it is not purchasable. Absent
configuration never means free.

`cire/api/src/routes/payment-webhook.ts` is retired — a provider-neutral 501
skeleton nothing enabled, and two webhook landing spots is the ambiguity that
gets the wrong one wired in a year.

Deployments need `STRIPE_PLATFORM_WEBHOOK_SECRET` (a second dashboard endpoint,
not the Connect one's secret) and `STRIPE_UPGRADE_PRICE_*` vars before anything
is for sale. See `wiki/systems/cire-upgrades.md` and the new §3.9 in
`wiki/runbooks/production-deploy.md`.
