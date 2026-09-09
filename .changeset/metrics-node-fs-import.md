---
"@tools/metrics": patch
---

Fix the blank dashboard. `Dashboard.tsx` value-imported `compactTokens` from
`tools/pr-metrics/index.ts`, which reads `node:fs` at module scope; Vite's
browser stub throws on first property access, so the app died during module
evaluation and left an empty page with nothing but a console error. It now
imports from the new `tools/pr-metrics/format.ts`, and a test guards both the
import and that file's no-imports contract.
