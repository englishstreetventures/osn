---
"@cire/api": patch
---

Refactor: import `createWorkersRateLimiter` / `WorkersRateLimitBinding` from the shared `@shared/rate-limit` package instead of the cire-local `lib/workers-rate-limiter.ts` (now removed). No behaviour change — the implementation was promoted into `@shared/rate-limit` so osn-api and cire-api share one fail-closed wrapper.
