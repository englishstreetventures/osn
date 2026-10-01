---
"@cire/api": patch
---

Guest routes answer a rate-limited request with 429 before the session lookup,
so a refused request costs no D1 read. The claim and restore responses read the
account-linking flag without waiting on a GrowthBook refresh while a recent
payload is cached.
