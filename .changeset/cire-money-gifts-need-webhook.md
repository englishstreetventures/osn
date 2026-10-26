---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
"@tools/e2e": patch
---

Guests are offered money gifts only where cire-api holds both the Stripe key and the Connect webhook secret that records each gift. With the key alone a guest could pay for a gift that stayed "Not cleared yet" in the couple's log for good.

- `@cire/api`: the contribute route, money and cash funds on the guest list, and a fund's picture all need `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. A signing secret of only whitespace counts as unset for both Stripe webhook routes, Connect and platform. With the key and no secret, building the app logs one warning, "money gifts disabled: STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET", naming the variables and never their values. `GET /registry` gains a top-level `takesPayments` saying whether this deployment can take a money gift at all.
- `@cire/host`: where `takesPayments` is false, the money-gifts panel says money gifts aren't available on this site yet; the switch cannot be turned on, but one saved on can still be turned off while Stripe can charge; a cash fund does not count towards publishing; and the gift list's hidden-funds notice names the site as the reason.
- `@cire/invites`: the organiser's preview note says guests give money here only when the list offers it.
- `@tools/e2e`: the stack's cire-api holds a placeholder Stripe key and no webhook secret, so the gift-list flows check that a key alone offers guests no money, and that cire-api logged its warning once; the preview flow checks the note leaves money out; and a new organiser flow, `cire-registry-money`, checks the portal says this site cannot take a money gift. cire-api's E2E seed adds the wedding it uses.
