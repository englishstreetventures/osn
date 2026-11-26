---
"@cire/api": patch
---

An agreement test, `tests/laws/deletion-weddings.test.ts`, runs one wedding's seat changes, erasures, deletes and restores through the Bend model in `tools/deletion-laws` and through cire-api's services, and fails when they disagree. It runs as the package's `test:repo` task. No production code changes.
