---
"@osn/db": patch
"@pulse/db": patch
"@zap/db": patch
"@pulse/landing": patch
"@shared/feature-flags": patch
"@shared/openapi-tools": patch
"@shared/design-tokens": patch
"@shared/color": patch
"@shared/dev-urls": patch
"@shared/rate-limit": patch
"@shared/rp-auth": patch
"@shared/toast": patch
"@shared/turnstile": patch
"@tools/lab": patch
---

Tests only: cases that a kept sibling already fails on are removed, each checked by breaking the source and watching both fail. Toast and dev-urls gain one case each, and four Toaster cases move to fake timers so they can fail on what they name.
