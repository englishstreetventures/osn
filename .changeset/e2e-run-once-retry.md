---
"@tools/e2e": patch
---

The Playwright config's comment says why a flow is never retried within a run: CI now runs the suite once and reruns a failed run whole, on a fresh stack.
