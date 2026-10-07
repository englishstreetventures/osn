---
"@shared/crypto": minor
"@shared/observability": patch
---

`@shared/crypto/recovery` exports the recovery-code helpers on their own, so a Worker can use them without the package index, which pulls in `@osn/db`. `generateRecoveryCode` builds its hex from the bytes directly, which type-checks under `@cloudflare/workers-types`; its output is unchanged.

The log redaction list gains `unlockCode`, the body field a cire owner redeems an unlock code with.
