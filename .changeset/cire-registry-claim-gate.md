---
"@cire/api": patch
"@tools/e2e": patch
---

Prove end to end that a couple's gift list stays behind the household's claim code.

- `@tools/e2e`: two flows. `cire-registry-locked` opens the gift list with no code, on both page addresses, asks the API directly, reads the public invite payload, opens the invitation, and comes back with a stale `cire_claimed` hint beside a session the API never issued: every list read answers 401 and none of the gifts, the couple's headline or their message reaches the visitor. `cire-registry-claimed` follows the locked page to the invitation, enters the household's code, sees the band and then the whole list, and signs out to find it locked again. A source test fails when the flows claim more codes than cire-api's claim limiter allows in a minute.
- `@cire/api`: the local server adds a second wedding, on Gold with a published list, when it boots with `CIRE_E2E_REGISTRY=1`, which only the E2E stack sets. The comment on the invite payload's gift-section copy now says that copy is public.
