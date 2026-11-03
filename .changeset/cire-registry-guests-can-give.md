---
"@cire/api": patch
"@cire/host": patch
"@tools/e2e": patch
---

The organiser portal says guests can give money, and counts a cash fund towards publishing, only where the guest list really offers money — including when the couple's Stripe account pays out in a currency other than the wedding's, or has not said which.

- `@cire/api`: the registry settings carry `moneyGiftsBlockedBy`, `null` when the guest list offers money and cash funds, otherwise the first reason it does not: `payments_unavailable`, `stripe_not_ready`, `stripe_currency_unknown`, `currency_mismatch` or `cash_gifts_off`. One function decides it for the guest list, a fund's picture and the contribute route alike. `GET /registry`, `PUT /registry/settings` (its answer, an empty save, the `settings_changed` refusal and the three money refusals, which now carry the settings too) and `POST …/registry/stripe/refresh` send it; the refresh answers from the row its write returned. A member who cannot edit is sent `cash_gifts_off` or `not_offered` in place of the two currency reasons, and the settlement currency itself is in no response.
- `@cire/host`: the gift list's hidden-funds notice and the publish notice name that reason, the currency included; the Money gifts panel says when the payout currency keeps guests from giving; "Check again" no longer calls an account ready while its currency does; an owner whose Stripe has not named its payout currency gets the one live Stripe read on load; a refused money save shows the reason its refusal carries; and saving the wedding in a new currency re-reads the gift list.
- `@tools/e2e`: `cire-registry-money` checks the registry read names `payments_unavailable` on the stack's site, which takes no money gifts.
