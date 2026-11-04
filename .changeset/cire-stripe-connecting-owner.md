---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@tools/e2e": patch
---

Once a wedding's Stripe account is connected, only the owner who connected it can open its onboarding links; the wedding's other owners see its status.

- `@cire/db`: `registry_settings.stripe_connected_by_osn_profile_id`, the OSN profile of the owner who connected the account (migration `20261104040827_registry_stripe_connected_by`, an added column with no back-fill).
- `@cire/api`: `POST …/registry/stripe/session` records the owner who connects a wedding's first account, in the write that fills `stripe_account_id`, and answers any other owner 403 `stripe_connector_only` before it calls Stripe — including an owner whose connect lost to another's, and every owner of an account with nobody on record. An account a losing connect minted is logged by id. `POST …/registry/stripe/refresh` stays open to every owner. Stripe deauthorizing the account clears the connector with the id. The registry settings carry `stripeConnectedByOsnProfileId`, `null` for a member who cannot edit.
- `@cire/host`: the Money gifts panel offers "Continue on Stripe" only to the owner who connected the account; another owner sees the status, the button disabled with a note that only the person who connected the account can continue it, and can still check again.
- `@tools/e2e`: `cire-registry-money` signs in as an owner of a wedding whose other owner connected its account, and checks the status-only panel, the 403 from the onboarding route and the unchanged row.
