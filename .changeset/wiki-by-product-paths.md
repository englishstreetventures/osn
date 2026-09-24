---
"@musubi/landing": patch
"@musubi/social": patch
"@osn/api": patch
"@osn/auth-ui": patch
"@osn/client": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/landing": patch
"@shared/design-tokens": patch
"@shared/observability": patch
"@shared/sortable": patch
"@shared/toast": patch
"@shared/ui": patch
"@tools/lab": patch
"@tools/metrics": patch
"@zap/api": patch
---

Point code comments at the wiki's new layout. The wiki now has one folder per
product (`osn/`, `musubi/`, `pulse/`, `cire/`, `zap/`) and `shared/` for what
applies to all of them, so references such as `wiki/systems/rate-limiting.md`
now read `wiki/shared/rate-limiting.md`. Comments only; no behaviour changes.
