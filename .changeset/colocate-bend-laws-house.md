---
"@tools/oxlint-house": patch
---

A new suite, `tests/law-set-imports.test.ts`, run by `test`, lints probe files with the root `oxlintrc.json` and fails unless importing a Bend law set (`<workspace>/laws/<topic>/`) is an error in a workspace's `src/` and allowed in its `tests/`. No rule changes.
