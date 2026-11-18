---
"@tools/stryker": patch
---

Mutation runs use Stryker 10.1.1. Its vitest runner joins a test's suite chain with ` > ` under Vitest 5, so the repository no longer patches it.
