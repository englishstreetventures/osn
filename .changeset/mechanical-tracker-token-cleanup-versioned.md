---
"@osn/api": patch
"@osn/client": patch
"@osn/db": patch
"@osn/social": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/db": patch
"@pulse/web": patch
"@shared/crypto": patch
"@shared/email": patch
"@shared/observability": patch
"@shared/osn-auth-client": patch
"@shared/redis": patch
"@shared/turnstile": patch
"@zap/api": patch
---

Clean up the `house/no-tracker-ref-in-comment` mechanical majority (xchromo/osn#924).

Every finding-tag, phase-code, and narrative-phrase reference flagged by the rule in a short comment block is now gone from these packages: a bare parenthetical tag deleted, a leading label stripped and the remainder capitalized into its own sentence, or a "used to be" narration rewritten forward to state the current, still-true fact. No behavior changes anywhere — every edit is comment text.

A handful of leftover `osn-tracker#N` citations that predated both this batch and the separate tracker-number-refs cleanup (xchromo/osn#930) are also gone from `@osn/api` and `@pulse/api`, using the same treatment established there.
