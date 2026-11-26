---
"@shared/crypto": minor
"@shared/osn-auth-client": minor
"@osn/api": minor
"@zap/api": patch
"@pulse/api": patch
---

Apps ask osn-api for the one ARC key a token names instead of the whole key list. `verifyOsnArcToken` (`@shared/osn-auth-client/arc`) fetches `<issuer>/.well-known/arc-jwks.json?kid=<ask>` and keeps an osn-api key four minutes from when its fetch started; it reads a whole-list answer the same way, so an osn-api on the earlier code still verifies. `resolvePublicKeyForKid`'s third argument is now a `KeyLookup` (`names`, the `from` URL, `ttlMs`), whose fetches share one flight per cache key apart from access-token fetches; two-argument calls are unchanged. `@shared/crypto/arc-kid` adds `ask` to `checkArcKid`'s lookup (the `<uuid>.<expiry>` and the parts shaped as MACs), `readArcKeyAsk`, which osn-api reads an ask with, and `holdsArcKidKey`.

osn-api answers `?kid=`: an ask no osn-api could have minted a kid for gets no key and no read; a kid one of whose MACs verifies under a secret it holds is answered from the isolate's memory (a key found held a minute from its read's start, one not found 30 seconds; at most 1,024 keys and, apart, 128 absences; asks share a read for five seconds), with one primary-key read when not held; a kid it cannot verify is answered from memory when its key is held, and otherwise read under 30 a minute per app zone or address (per Cloudflare location), holding a key found and never an absence. An app's ask spends no other budget and calls no coordination store. The whole list keeps its minute budgets and per-zone hour budget; every address now shares one hour budget of 60. A failed key read answers 500. New counter `osn.arc.jwks.key_lookups`; `osn.arc.jwks.refused` gains reason `probe`. Zap's and Pulse's test stand-ins answer by kid.
