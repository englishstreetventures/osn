---
"@osn/api": patch
"@pulse/api": patch
"@zap/api": patch
"@shared/observability": patch
---

Drop five `Logger` imports left dead by the v4 logger rework, and finish the
Effect v4 migration: with `@cire/api` moved off v3 in the same change, the
whole monorepo type-checks and passes its tests under Effect v4.

The observability change is the test-only one: `Logger.layer` replaces the
whole active logger set, so the default logger that used to emit a separate
"Fiber terminated…" stack dump is gone, and a capture is now exactly the
entry under test.
