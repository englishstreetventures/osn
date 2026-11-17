---
"@cire/api": patch
"@cire/infra": patch
---

The E2E organiser seed adds Fund Wedding (`wed_e2e_fund`): on Gold, a published gift list with nothing on it, money gifts on, an Express account its second owner connected, and one household of one guest, for the suite's guest gift through the Stripe stand-in. Local and E2E only; no deployed tier runs this seed. The local server listens on the address `CIRE_LOCAL_HOSTNAME` names, which the E2E stack sets to `127.0.0.1`; unset, it listens on every interface as before. `@cire/infra`'s check of what cire-api reads on dev lists `CIRE_LOCAL_HOSTNAME` among the names the dev stack leaves unset.
