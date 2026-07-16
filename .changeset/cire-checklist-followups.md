---
---

cire checklist hardening: a cross-tenant regression test proving `tasksService.reorder`
is wedding-scoped (an owner of wedding B cannot shuffle wedding A's checklist), and a
`readonly TimeframeBucket[]` type annotation on `TIMEFRAME_BUCKET_KEYS`. Test + type
only, no behaviour change (`cire/api`).
