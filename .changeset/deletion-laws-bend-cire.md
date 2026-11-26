---
"@cire/api": patch
---

An agreement test, `tests/laws/deletion-weddings.test.ts`, runs one wedding's seat changes, erasures, deletes and restores through the Bend model in `laws/account-deletion/` and through cire-api's services, and fails when they disagree. It runs in the package's `test`. No production code changes.
