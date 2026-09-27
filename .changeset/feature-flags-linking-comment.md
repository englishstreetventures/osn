---
"@shared/feature-flags": patch
---

Describe the `cire.account-linking` flag as cire-api now applies it: it decides
whether the claim and restore responses offer a household linking, and gates
`POST /api/account/link`. Documentation only; no behaviour change.
