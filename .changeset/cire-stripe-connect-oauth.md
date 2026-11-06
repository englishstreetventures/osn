---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/infra": patch
"@tools/e2e": patch
---

An owner can connect a Stripe account they already have to a wedding's gift registry, through Stripe Connect OAuth. The account question gains a third answer, "Connect a Stripe account you already have", which says that Stripe's fees come out of each gift at the account's own rates and that refunds and disputes are the couple's, in their own Stripe Dashboard. `POST …/registry/stripe/oauth` sends the owner to Stripe's authorize page with a state bound to them and the wedding. It is single-use, lasts 30 minutes and is kept only as its SHA-256 in the new `registry_stripe_oauth_states` table. `GET /api/organiser/stripe/oauth/callback` exchanges the code on the organiser session cookie, stores only the account id, and always answers a redirect to the portal with `?stripe_connect=<outcome>`.

`registry_settings.stripe_account_type` (`express` or `standard`, NULL read as `express`) tells the two apart. A Standard account gets no onboarding link: `…/stripe/session` answers 409 `stripe_standard_account`, and the panel links its connector to their Stripe Dashboard. A completed Checkout Session on one settles only a gift that stored its id. Unmatched refunds and disputes on one are counted, not raised. An account another wedding names joins only under the reuse rules. An account cire connects and cannot use is handed back unless a wedding names it, and so is a purged wedding's. A deauthorization clears only rows that knew the account before Stripe's event.

Off unless `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_SECRET_KEY` and `CIRE_API_ORIGIN` are all set. The E2E suite gains a Stripe stand-in and checks the connect in `cire-registry-money`.
