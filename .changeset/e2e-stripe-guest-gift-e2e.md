---
"@tools/e2e": patch
---

A guest gives money to a cash fund end to end on the E2E stack. The stack's cire-api now holds the Connect webhook's secret, so it takes money gifts, and the Stripe stand-in serves a Checkout session on a connected account and signs its `checkout.session.completed` with the account and that secret. `cire-registry-money` adds a fund through the portal's form on a new wedding, a guest chooses it on the gift page and pays through the stand-in, and the flow checks the gift row reads `succeeded` under the fund's name. A second cire-api with the key and no secret keeps the deployment that offers no money gift under test: `cire-registry-claimed` and `cire-registry-preview` run against it through `throughKeyOnlyCireApi`.
