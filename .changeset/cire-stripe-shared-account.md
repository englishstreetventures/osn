---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@tools/e2e": patch
---

An owner can give a second wedding the Stripe account they connected on another, so two weddings take their gifts through one account, and pressing "Connect an account" asks which account to use.

- `@cire/db`: a partial index on `registry_settings.stripe_account_id` (migration `20261105010837_registry_stripe_account_idx`), for the webhook writes that update every wedding naming an account.
- `@cire/api`: `GET …/registry/stripe/accounts` lists the accounts the caller connected on other weddings they own, by wedding name, with no account id or currency. `POST …/registry/stripe/reuse` takes a wedding id, never an account id, and gives this wedding that wedding's account in one statement, only when the caller is on record as its connector there and still owns that wedding, every owner here owns it too, and the account settles in this wedding's currency; any other source is one 404. No Stripe call. A create that loses a race to a reuse keeps the reused row's Stripe timestamp.
- `@cire/host`: pressing "Connect an account" on a wedding with no account asks which account should take its gifts, with nothing chosen, when the owner has one on another wedding; "Use this account" stays in the portal. The delete dialog says a connected account keeps taking gifts for any other wedding that uses it.
- `@tools/e2e`: `cire-registry-money` refuses another owner's account, shows the question on a second wedding and gives it the owner's own account.
