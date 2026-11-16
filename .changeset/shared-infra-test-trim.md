---
"@shared/infra": patch
---

Tests only. Removes 23 cases and the one-case `tests/index.test.ts` that another named test already checks, in this package or in the cire, musubi and zap stack tests, and two of `tests/dev-hosts.test.ts`'s spawned inputs that `tests/hosts.test.ts` already refuses. The `checkLive` ordering case in `tests/secrets/check.test.ts` runs on fake timers. Every refusal, redaction and drift guard keeps a test.
