---
"@musubi/landing": patch
"@musubi/social": patch
"@osn/api": patch
"@osn/auth-ui": patch
"@osn/client": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@pulse/landing": patch
"@pulse/web": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/dev-urls": patch
"@shared/email": patch
"@shared/legal": patch
"@shared/observability": patch
"@shared/rate-limit": patch
"@shared/redis": patch
"@shared/ui": patch
"@zap/api": patch
"@zap/db": patch
---

Delete low-signal unit tests: constants asserted against themselves, mock echoes, valid-object schema acceptances with no edge, static render checks and duplicates. Tests only; no runtime change.
