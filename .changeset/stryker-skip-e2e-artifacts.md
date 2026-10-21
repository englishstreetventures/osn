---
"@tools/stryker": patch
---

The cire mutation sandbox skips `e2e-artifacts/`, so a mutation run no longer fails when the e2e suite is running alongside it.
