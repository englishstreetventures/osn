---
"@tools/pr-metrics": patch
---

Move `compactTokens` and `humanDuration` into `format.ts`, which imports
nothing, so a browser can use them without pulling in the CLI's `node:fs`.
Both are re-exported from `index.ts`, so no caller changes.
