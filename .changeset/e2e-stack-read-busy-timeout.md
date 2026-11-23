---
"@tools/e2e": patch
---

The e2e suite's stack-database reads and writes wait up to two seconds for a server write lock instead of failing with `database is locked`.
