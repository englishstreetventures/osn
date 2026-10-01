---
"@osn/api": patch
"@pulse/api": patch
"@zap/api": patch
"@shared/dev-urls": patch
---

`drizzle-orm` is patched so a failed query's error message carries only the SQL
text, and its bound values sit on a non-enumerable `params` field. A failed
write no longer puts personal data into log lines, `String(e)` reasons or
exported span exceptions. `@shared/dev-urls`: its test mirroring the cire
`WEB_ORIGIN` rule follows the stricter exact-origin check.
