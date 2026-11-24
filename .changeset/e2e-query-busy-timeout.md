---
"@tools/e2e": patch
---

`queryOne` waits up to five seconds for a stack server's write lock instead of failing at once with `database is locked`; `writeRow` opens through the same helper and keeps the same wait. `tests/fixtures.test.ts` holds a write transaction open while a second process calls each helper, and requires the committed row. `musubi-account-deletion` closes the heir's context only once the organisation list the decline lands on has answered its read, so every run records that read.
