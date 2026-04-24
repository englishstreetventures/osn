---
"@pulse/db": minor
"@pulse/api": minor
"@pulse/app": patch
---

Add optional `price` to Pulse events.

- `events.price_amount` (integer, nullable, minor units) + `events.price_currency` (text, nullable, ISO 4217) columns.
- API accepts `priceAmount` in major units (decimal, cap 99999.99) + `priceCurrency` from a curated allowlist (USD, EUR, GBP, CAD, AUD, JPY). Enforced "both set or both null" invariant at the service layer.
- Create-event form gets a price + currency input; badge shows "Free" when unset or 0, otherwise `Intl.NumberFormat`-formatted value.
